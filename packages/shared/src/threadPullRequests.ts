import type {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

/** Identity comparison for links: host-level, case-insensitive on host and repository. */
export function threadPullRequestKeysEqual(
  left: ThreadPullRequestKey,
  right: ThreadPullRequestKey,
): boolean {
  return (
    left.number === right.number &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  );
}

export function threadPullRequestKeyOf(key: ThreadPullRequestKey): string {
  return `${key.host.toLowerCase()}/${key.repository.toLowerCase()}#${key.number}`;
}

/** Links a user should see. Tombstoned stack members stay in the array only so the
 * sync reactor does not re-add them. */
export function visibleThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestLink> {
  return links.filter((link) => link.source !== "stack-dismissed");
}

function isOpen(link: ThreadPullRequestLink): boolean {
  // Unsynced links are treated as open: they were just linked, and hiding them
  // behind a terminal PR until the first sync would make the link look lost.
  return link.snapshot === null || link.snapshot.state === "open";
}

function latestUpdatedAt(link: ThreadPullRequestLink): number {
  const value = link.snapshot?.updatedAt ?? link.linkedAt;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function layerIndex(link: ThreadPullRequestLink): number {
  const layers = link.stack?.layers;
  if (layers === undefined) return -1;
  return layers.findIndex((layer) => layer.number === link.number);
}

/** The single pull request a one-slot surface (sidebar badge, tab icon, copy link) shows. */
export type ThreadCurrentPullRequest =
  | { readonly kind: "single"; readonly link: ThreadPullRequestLink }
  | {
      readonly kind: "stack";
      readonly open: ReadonlyArray<ThreadPullRequestLink>;
      /** Highest layer of the open set; the one "View PR" and copy-link target. */
      readonly top: ThreadPullRequestLink;
    };

/**
 * Prefer open work: one open link is the thread's PR; several open links are a stack and
 * the surface shows a stack glyph instead of guessing; with nothing open, the most recently
 * updated terminal link stands in so a merged thread still points at what it shipped.
 */
export function resolveThreadCurrentPullRequest(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ThreadCurrentPullRequest | null {
  const visible = visibleThreadPullRequests(links);
  if (visible.length === 0) return null;
  const open = visible.filter(isOpen);
  if (open.length === 1) return { kind: "single", link: open[0]! };
  if (open.length > 1) {
    const ordered = [...open].sort((left, right) => {
      const layerDelta = layerIndex(right) - layerIndex(left);
      if (layerDelta !== 0) return layerDelta;
      return Date.parse(right.linkedAt) - Date.parse(left.linkedAt);
    });
    return { kind: "stack", open: ordered, top: ordered[0]! };
  }
  const terminal = [...visible].sort(
    (left, right) => latestUpdatedAt(right) - latestUpdatedAt(left),
  );
  return { kind: "single", link: terminal[0]! };
}

/** The one link a legacy `linkedPullRequest` consumer should see, or null. */
export function resolveThreadCurrentPullRequestLink(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ThreadPullRequestLink | null {
  const current = resolveThreadCurrentPullRequest(links);
  if (current === null) return null;
  return current.kind === "single" ? current.link : current.top;
}

/**
 * Compat shape for clients that predate `pullRequests`. `projectId` is the routing hint the
 * old shape carried; callers pass the thread's own project because the legacy consumers
 * only ever linked pull requests from it.
 */
export function legacyLinkedPullRequestOf(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: ThreadLinkedPullRequest["projectId"],
): ThreadLinkedPullRequest | null {
  const link = resolveThreadCurrentPullRequestLink(links);
  if (link === null) return null;
  return { projectId, repository: link.repository, number: link.number, url: link.url };
}

export interface ThreadPullRequestChain {
  readonly kind: "native" | "derived";
  /** Bottom to top. */
  readonly layers: ReadonlyArray<ThreadPullRequestLink>;
}

/**
 * Groups a thread's links into stacks. Native stacks come from the host and win; the rest
 * are chained by matching one link's base branch to another's head branch within the same
 * repository. A link that chains to nothing is a one-layer chain.
 */
export function resolveThreadPullRequestChains(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestChain> {
  const visible = visibleThreadPullRequests(links);
  const chains: Array<ThreadPullRequestChain> = [];
  const placed = new Set<string>();

  const nativeStacks = new Map<string, Array<ThreadPullRequestLink>>();
  for (const link of visible) {
    if (link.stack === null) continue;
    const stackKey = `${link.host}/${link.repository}#stack:${link.stack.id}`;
    const members = nativeStacks.get(stackKey) ?? [];
    members.push(link);
    nativeStacks.set(stackKey, members);
  }
  for (const members of nativeStacks.values()) {
    const order = new Map(members[0]!.stack!.layers.map((layer, index) => [layer.number, index]));
    members.sort((left, right) => (order.get(left.number) ?? 0) - (order.get(right.number) ?? 0));
    for (const member of members) placed.add(threadPullRequestKeyOf(member));
    chains.push({ kind: "native", layers: members });
  }

  const remaining = visible.filter((link) => !placed.has(threadPullRequestKeyOf(link)));
  const byHead = new Map<string, ThreadPullRequestLink>();
  for (const link of remaining) {
    if (link.snapshot === null) continue;
    byHead.set(`${link.host}/${link.repository}:${link.snapshot.headBranch}`.toLowerCase(), link);
  }
  const hasChild = new Set<string>();
  for (const link of remaining) {
    if (link.snapshot === null) continue;
    const parent = byHead.get(
      `${link.host}/${link.repository}:${link.snapshot.baseBranch}`.toLowerCase(),
    );
    if (parent !== undefined && parent !== link) hasChild.add(threadPullRequestKeyOf(parent));
  }
  // Walk from each top (a link nothing builds on) down its base chain.
  for (const top of remaining) {
    if (hasChild.has(threadPullRequestKeyOf(top))) continue;
    const layers: Array<ThreadPullRequestLink> = [];
    let cursor: ThreadPullRequestLink | undefined = top;
    while (cursor !== undefined && !placed.has(threadPullRequestKeyOf(cursor))) {
      placed.add(threadPullRequestKeyOf(cursor));
      layers.unshift(cursor);
      cursor =
        cursor.snapshot === null
          ? undefined
          : byHead.get(
              `${cursor.host}/${cursor.repository}:${cursor.snapshot.baseBranch}`.toLowerCase(),
            );
    }
    if (layers.length > 0) chains.push({ kind: "derived", layers });
  }
  return chains;
}
