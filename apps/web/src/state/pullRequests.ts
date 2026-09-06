import { useAtomValue } from "@effect/atom-react";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
} from "@t3tools/client-runtime/state/pull-requests";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestDetail,
  PullRequestListInput,
  PullRequestListStatsInput,
  PullRequestRef,
  PullRequestSummary,
  VcsStatusResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  mergePullRequestLists,
  readPullRequestListSnapshot,
  writePullRequestListSnapshot,
  type PullRequestPartitionsSnapshot,
  type EnvironmentPullRequestStat,
  type MergedPullRequestList,
  type EnvironmentPullRequestEntry,
} from "../components/pullRequest/pullRequestList.logic";
import {
  PULL_REQUEST_DETAIL_SNAPSHOT_MAX_ENTRIES,
  readPullRequestDetailSnapshot,
  readPullRequestDetailSnapshotReferences,
  writePullRequestDetailSnapshot,
} from "../components/pullRequest/pullRequestDetail.logic";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";

export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime);
export const linkedPullRequestDetailAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  pullRequestEnvironment.refreshes,
);

type PullRequestTarget = EnvironmentQueryTarget<PullRequestRef>;

interface PullRequestSnapshot {
  readonly detail: PullRequestDetail | null;
  readonly summary: PullRequestSummary | null;
  readonly revision: number;
}

function pullRequestKey({ environmentId, input }: PullRequestTarget): string {
  return JSON.stringify([
    environmentId,
    input.projectId,
    input.repository.toLowerCase(),
    input.number,
  ]);
}

function normalizedPullRequestUrl(url: string): string {
  return url.split(/[?#]/u)[0]!.replace(/\/$/u, "").toLowerCase();
}

export function samePullRequestUrl(left: string, right: string): boolean {
  return normalizedPullRequestUrl(left) === normalizedPullRequestUrl(right);
}

function pullRequestUrlKey(environmentId: EnvironmentId, projectId: ProjectId, url: string) {
  return JSON.stringify([environmentId, projectId, normalizedPullRequestUrl(url)]);
}

function targetFromKey(key: string): PullRequestTarget {
  const [environmentId, projectId, repository, number] = JSON.parse(key) as [
    EnvironmentId,
    ProjectId,
    string,
    number,
  ];
  return { environmentId, input: { projectId, repository, number } };
}

function matchesPullRequest(
  reference: PullRequestRef & { readonly url?: string },
  value: PullRequestSummary,
): boolean {
  return (
    reference.projectId === value.projectId &&
    reference.repository.toLowerCase() === value.repository.toLowerCase() &&
    reference.number === value.number &&
    (reference.url === undefined || samePullRequestUrl(reference.url, value.url))
  );
}

function samePullRequest(left: PullRequestSummary, right: PullRequestSummary): boolean {
  return matchesPullRequest(left, right) && left.provider === right.provider;
}

/** Store only summary fields. A typed detail value still has its other fields at runtime. */
function pullRequestSummary(value: PullRequestSummary): PullRequestSummary {
  return {
    provider: value.provider,
    projectId: value.projectId,
    repository: value.repository,
    number: value.number,
    title: value.title,
    url: value.url,
    state: value.state,
    ...(value.isDraft === undefined ? {} : { isDraft: value.isDraft }),
    headBranch: value.headBranch,
    baseBranch: value.baseBranch,
    ...(value.closedAt === undefined ? {} : { closedAt: value.closedAt }),
    ...(value.mergedAt === undefined ? {} : { mergedAt: value.mergedAt }),
    updatedAt: value.updatedAt,
  };
}

function observedPullRequestIsNewer(
  current: Pick<NonNullable<VcsStatusResult["pr"]>, "state" | "updatedAt">,
  observed: Pick<PullRequestSummary, "state" | "updatedAt">,
): boolean {
  if (current.state === "merged" && observed.state !== "merged") return false;
  if (observed.state === "merged" && current.state !== "merged") return true;
  return (
    current.updatedAt == null || Date.parse(observed.updatedAt) >= Date.parse(current.updatedAt)
  );
}

export function newestPullRequestSummary(
  current: PullRequestSummary | null,
  observed: PullRequestSummary | null,
): PullRequestSummary | null {
  if (current === null) return observed;
  if (observed === null || !samePullRequest(current, observed)) return current;
  return observedPullRequestIsNewer(current, observed) ? observed : current;
}

function applyPullRequestSummary<T extends PullRequestSummary>(
  current: T,
  observed: PullRequestSummary | null,
): T {
  const newest = newestPullRequestSummary(current, observed);
  if (newest === null || newest === current) return current;
  const summary = pullRequestSummary(newest);
  if (Object.entries(summary).every(([key, value]) => current[key as keyof T] === value)) {
    return current;
  }
  return { ...current, ...summary };
}

function sameSummary(left: PullRequestSummary | null, right: PullRequestSummary | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      Object.entries(left).every(
        ([key, value]) => right[key as keyof PullRequestSummary] === value,
      ) &&
      Object.entries(right).every(
        ([key, value]) => left[key as keyof PullRequestSummary] === value,
      ))
  );
}

function hasEqualTimeSummaryConflict(
  current: PullRequestSummary | null,
  detail: PullRequestSummary,
): boolean {
  if (
    current === null ||
    !samePullRequest(current, detail) ||
    current.state === "merged" ||
    detail.state === "merged" ||
    Date.parse(current.updatedAt) !== Date.parse(detail.updatedAt)
  )
    return false;
  return (
    ["title", "state", "isDraft", "headBranch", "baseBranch", "closedAt", "mergedAt"] as const
  ).some(
    (key) =>
      current[key] !== undefined && detail[key] !== undefined && current[key] !== detail[key],
  );
}

function resolvePullRequestSnapshot(
  previous: PullRequestSnapshot,
  observation: PullRequestSummary,
  detail: PullRequestDetail | null,
  freshDetail = false,
): PullRequestSnapshot {
  const sameIdentity = previous.summary === null || samePullRequest(previous.summary, observation);
  if (!sameIdentity && detail === null && previous.detail !== null) return previous;
  const previousDetail = sameIdentity ? previous.detail : null;
  // Viewer permissions belong to the latest viewer, not to the PR's update timestamp.
  const nextDetail =
    detail !== null &&
    (previousDetail === null ||
      detail.viewer !== previousDetail.viewer ||
      Date.parse(detail.updatedAt) >= Date.parse(previousDetail.updatedAt))
      ? detail
      : previousDetail;
  // Equal host timestamps cannot order independent summary and held-detail responses.
  // Keep the accepted summary until a read after explicit host invalidation confirms it.
  const newest =
    !freshDetail && hasEqualTimeSummaryConflict(previous.summary, observation)
      ? previous.summary!
      : (newestPullRequestSummary(sameIdentity ? previous.summary : null, observation) ??
        observation);
  const candidateSummary = {
    ...(sameIdentity ? previous.summary : null),
    ...pullRequestSummary(newest),
  };
  const summary = sameSummary(previous.summary, candidateSummary)
    ? previous.summary!
    : candidateSummary;
  const previousSummary = previous.summary;
  const changedRevision =
    previousSummary !== null &&
    (!sameIdentity ||
      summary.updatedAt !== previousSummary.updatedAt ||
      summary.state !== previousSummary.state);
  if (nextDetail === previous.detail && summary === previous.summary) {
    return previous;
  }
  return { detail: nextDetail, summary, revision: previous.revision + Number(changedRevision) };
}

/** Own accepted detail, summary, and refresh revisions for each environment and PR reference. */
export function createPullRequestState(
  registry: AtomRegistry.AtomRegistry,
  options: {
    readonly storage: () => Storage | undefined;
    readonly onRevisionChanged: (target: PullRequestTarget) => void;
    readonly readFreshDetail?: (
      target: PullRequestTarget,
      signal: AbortSignal,
    ) => Promise<PullRequestDetail | null>;
  },
) {
  const storage = () => {
    try {
      return options.storage();
    } catch {
      return undefined;
    }
  };
  // Query atoms can keep the same answer across refreshes and remounts. Each answer
  // can update a PR once per observation kind, even when its timestamp is unchanged.
  const observations = Atom.make(() => new WeakMap<PullRequestSummary, Set<string>>()).pipe(
    Atom.keepAlive,
  );
  const snapshots = Atom.family((key: string) =>
    Atom.writable(
      (): PullRequestSnapshot => {
        const { environmentId, input: reference } = targetFromKey(key);
        const stored = readPullRequestDetailSnapshot(storage(), environmentId, reference);
        if (stored === null || !matchesPullRequest(reference, stored)) {
          return { detail: null, summary: null, revision: 0 };
        }
        const { observedSummary, ...detail } = stored;
        return {
          detail,
          summary: pullRequestSummary(
            newestPullRequestSummary(detail, observedSummary ?? null) ?? detail,
          ),
          revision: 0,
        };
      },
      (context, value: PullRequestSnapshot) => context.setSelf(value),
    ).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`web-pull-requests:snapshot:${key}`)),
  );
  // Read the bounded saved index once so detected-only sidebars can hydrate after a reload.
  const savedReferences = Atom.make(
    () =>
      new Map(
        readPullRequestDetailSnapshotReferences(storage()).map(({ environmentId, input, url }) => [
          pullRequestUrlKey(environmentId, input.projectId, url),
          { environmentId, input },
        ]),
      ),
  ).pipe(Atom.keepAlive);
  // Detected VCS PRs carry a URL, not the host's repository reference. This index points at
  // the same snapshot and never copies its status or shares it across projects.
  const referencesByUrl = Atom.family((key: string) =>
    Atom.writable(
      (get): PullRequestTarget | null => get(savedReferences).get(key) ?? null,
      (context, value: PullRequestTarget) => context.setSelf(value),
    ).pipe(Atom.setIdleTTL(5 * 60_000)),
  );
  const summariesByUrl = Atom.family((key: string) =>
    Atom.make((get) => {
      const target = get(referencesByUrl(key));
      if (target === null) return null;
      const summary = get(snapshots(pullRequestKey(target))).summary;
      return summary !== null &&
        pullRequestUrlKey(target.environmentId, target.input.projectId, summary.url) === key
        ? summary
        : null;
    }).pipe(Atom.setIdleTTL(5 * 60_000)),
  );
  const snapshot = (target: PullRequestTarget) => snapshots(pullRequestKey(target));
  const registerReference = (target: PullRequestTarget, value: PullRequestSummary) => {
    if (!matchesPullRequest(target.input, value)) return;
    const urlReference = referencesByUrl(
      pullRequestUrlKey(target.environmentId, target.input.projectId, value.url),
    );
    if (registry.get(urlReference) === null) registry.set(urlReference, target);
  };
  const confirmations = Atom.make((get) => {
    const pending = new Map<string, AbortController>();
    get.addFinalizer(() => {
      for (const controller of pending.values()) controller.abort();
    });
    return pending;
  }).pipe(Atom.keepAlive);
  const observe = (
    target: PullRequestTarget,
    value: PullRequestSummary,
    detail: PullRequestDetail | null = null,
    freshDetail = false,
  ) => {
    if (!matchesPullRequest(target.input, value)) return;
    const atom = snapshot(target);
    const previous = registry.get(atom);
    const seen = registry.get(observations);
    const sourceKey = JSON.stringify([pullRequestKey(target), detail !== null]);
    const accepted = seen.get(value);
    if (!freshDetail && previous.summary !== null && accepted?.has(sourceKey)) {
      registerReference(target, value);
      return;
    }
    if (accepted === undefined) seen.set(value, new Set([sourceKey]));
    else accepted.add(sourceKey);
    const next = resolvePullRequestSnapshot(previous, value, detail, freshDetail);
    if (next !== previous) {
      registry.set(atom, next);
      if (next.detail !== null) {
        writePullRequestDetailSnapshot(
          storage(),
          target.environmentId,
          targetFromKey(pullRequestKey(target)).input,
          {
            ...next.detail,
            ...(next.summary === null ? {} : { observedSummary: next.summary }),
          },
        );
        const saved = registry.get(savedReferences);
        const urlKey = pullRequestUrlKey(
          target.environmentId,
          target.input.projectId,
          next.detail.url,
        );
        saved.delete(urlKey);
        saved.set(urlKey, target);
        if (saved.size > PULL_REQUEST_DETAIL_SNAPSHOT_MAX_ENTRIES) {
          const oldest = saved.keys().next().value;
          if (oldest !== undefined) saved.delete(oldest);
        }
      }
      if (next.revision !== previous.revision)
        options.onRevisionChanged(targetFromKey(pullRequestKey(target)));
    }
    const pending = registry.get(confirmations);
    if (
      !freshDetail &&
      hasEqualTimeSummaryConflict(previous.summary, value) &&
      options.readFreshDetail !== undefined &&
      !pending.has(pullRequestKey(target))
    ) {
      const key = pullRequestKey(target);
      const expectedSummary = next.summary;
      // The in-flight map holds only active reads. Multiple mounted readers share this request.
      const controller = new AbortController();
      pending.set(key, controller);
      void options
        .readFreshDetail(target, controller.signal)
        .then((fresh) => {
          if (
            !controller.signal.aborted &&
            fresh !== null &&
            registry.get(atom).summary === expectedSummary
          )
            observe(target, fresh, fresh, true);
        })
        .catch(() => {
          // Keep the accepted summary if the host is unavailable. A later new response can retry.
        })
        .finally(() => pending.delete(key));
    }
    registerReference(target, value);
  };
  return {
    snapshot,
    registerReference,
    observeSummary: (target: PullRequestTarget, value: PullRequestSummary) =>
      observe(target, value),
    observeDetail: (target: PullRequestTarget, value: PullRequestDetail) =>
      observe(target, value, value),
    summaryByUrl: (environmentId: EnvironmentId, projectId: ProjectId, url: string) =>
      summariesByUrl(pullRequestUrlKey(environmentId, projectId, url)),
    invalidate: (target: PullRequestTarget) =>
      registry.update(snapshot(target), (previous) => ({
        ...previous,
        revision: previous.revision + 1,
      })),
  };
}

function pullRequestSnapshotStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const pullRequestState = createPullRequestState(appAtomRegistry, {
  storage: pullRequestSnapshotStorage,
  onRevisionChanged: (target) => appAtomRegistry.refresh(pullRequestEnvironment.activity(target)),
  readFreshDetail: async (target, signal) => {
    const invalidated = await pullRequestEnvironment.invalidate.run(appAtomRegistry, {
      environmentId: target.environmentId,
      input: { reference: target.input },
    });
    if (signal.aborted || !AsyncResult.isSuccess(invalidated)) return null;
    const query = pullRequestEnvironment.detail(target);
    appAtomRegistry.refresh(query);
    const result = await executeAtomQuery(appAtomRegistry, query, { signal });
    return AsyncResult.isSuccess(result) ? result.value : null;
  },
});

const emptyPullRequestSnapshot = Atom.make<PullRequestSnapshot>({
  detail: null,
  summary: null,
  revision: 0,
});
const emptyPullRequestSummary = Atom.make<PullRequestSummary | null>(null);

export function useSharedPullRequestSummary(
  environmentId: EnvironmentId | null,
  reference: (PullRequestRef & { readonly url?: string }) | null,
  current: PullRequestSummary | null,
): PullRequestSummary | null {
  const key =
    environmentId === null || reference === null
      ? null
      : pullRequestKey({ environmentId, input: reference });
  const target = useMemo(() => (key === null ? null : targetFromKey(key)), [key]);
  const observed = useAtomValue(
    target === null ? emptyPullRequestSnapshot : pullRequestState.snapshot(target),
  );
  const matching =
    reference !== null && current !== null && matchesPullRequest(reference, current)
      ? current
      : null;
  const shared =
    reference !== null &&
    observed.summary !== null &&
    matchesPullRequest(reference, observed.summary)
      ? observed.summary
      : null;
  useLayoutEffect(() => {
    if (target !== null && matching !== null) pullRequestState.observeSummary(target, matching);
  }, [matching, target]);
  useLayoutEffect(() => {
    if (target !== null && shared !== null) pullRequestState.registerReference(target, shared);
  }, [shared, target]);
  return target === null ? null : newestPullRequestSummary(matching, shared);
}

/** Apply a confirmed PR observation after checkout/branch association has been resolved. */
export function resolveSharedThreadPullRequest(
  current: VcsStatusResult["pr"],
  summary: PullRequestSummary | null,
): VcsStatusResult["pr"] {
  if (current === null || summary === null) return current;
  if (!samePullRequestUrl(current.url, summary.url)) return current;
  if (!observedPullRequestIsNewer(current, summary)) return current;
  return {
    ...current,
    title: summary.title,
    state: summary.state,
    ...(summary.isDraft === undefined ? {} : { isDraft: summary.isDraft }),
    headRef: summary.headBranch,
    baseRef: summary.baseBranch,
    updatedAt: summary.updatedAt,
  };
}

export function useSharedThreadPullRequest(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  current: VcsStatusResult["pr"],
): VcsStatusResult["pr"] {
  const summary = useAtomValue(
    environmentId === null || projectId === null || current === null
      ? emptyPullRequestSummary
      : pullRequestState.summaryByUrl(environmentId, projectId, current.url),
  );
  return useMemo(() => resolveSharedThreadPullRequest(current, summary), [current, summary]);
}

/** The same scoped detail is used by the panel, tab icon, and copy-link action. */
export function usePullRequestDetail(target: PullRequestTarget | null) {
  const key = target === null ? null : pullRequestKey(target);
  const stableTarget = useMemo(() => (key === null ? null : targetFromKey(key)), [key]);
  const query = useEnvironmentQuery(
    stableTarget === null ? null : pullRequestEnvironment.detail(stableTarget),
  );
  const snapshot = useAtomValue(
    stableTarget === null ? emptyPullRequestSnapshot : pullRequestState.snapshot(stableTarget),
  );
  const resolved = useMemo(() => {
    // A shared summary changing does not make the stored query value a new observation.
    if (
      query.data === snapshot.detail ||
      query.data === null ||
      stableTarget === null ||
      !matchesPullRequest(stableTarget.input, query.data)
    )
      return snapshot;
    return resolvePullRequestSnapshot(snapshot, query.data, query.data);
  }, [query.data, snapshot, stableTarget]);
  useLayoutEffect(() => {
    if (stableTarget !== null && query.data !== null)
      pullRequestState.observeDetail(stableTarget, query.data);
  }, [query.data, stableTarget]);
  useLayoutEffect(() => {
    if (stableTarget !== null && snapshot.summary !== null)
      pullRequestState.registerReference(stableTarget, snapshot.summary);
  }, [snapshot.summary, stableTarget]);
  const data = useMemo(
    () =>
      resolved.detail === null ? null : applyPullRequestSummary(resolved.detail, resolved.summary),
    [resolved.detail, resolved.summary],
  );
  return { ...query, data, revision: snapshot.revision };
}

export function refreshPullRequest(target: PullRequestTarget, includeDiff = false): void {
  const queryTarget = targetFromKey(pullRequestKey(target));
  appAtomRegistry.refresh(pullRequestEnvironment.detail(queryTarget));
  appAtomRegistry.refresh(pullRequestEnvironment.activity(queryTarget));
  if (includeDiff) pullRequestState.invalidate(target);
}

export async function refreshPullRequestFromHost(target: PullRequestTarget): Promise<void> {
  await pullRequestEnvironment.invalidate.run(appAtomRegistry, {
    environmentId: target.environmentId,
    input: { reference: target.input },
  });
  refreshPullRequest(target, true);
}

/** Keep local list order and account fields while applying newer PR observations. */
export function useObservedPullRequestEntries(entries: ReadonlyArray<EnvironmentPullRequestEntry>) {
  const atom = useMemo(
    () =>
      Atom.make((get) =>
        entries.map((entry) =>
          applyPullRequestSummary(
            entry,
            get(
              pullRequestState.snapshot({
                environmentId: entry.environmentId,
                input: {
                  projectId: entry.projectId,
                  repository: entry.repository,
                  number: entry.number,
                },
              }),
            ).summary,
          ),
        ),
      ),
    [entries],
  );
  return useAtomValue(atom);
}

interface RetainedPullRequestList {
  readonly environmentKey: string;
  readonly scope: string;
  readonly query: string;
  readonly data: MergedPullRequestList;
  readonly partitions?: PullRequestPartitionsSnapshot | undefined;
}

/** Hydrate only the selected environment set and persist complete, unsearched list answers. */
export function useRetainedPullRequestList({
  environmentKey,
  scope,
  query,
  live,
  baseline,
  orderedEntries,
  authored,
  reviewing,
}: {
  readonly environmentKey: string;
  readonly scope: string;
  readonly query: string;
  readonly live: Pick<MergedPullRequestListView, "data" | "isPending">;
  readonly baseline: MergedPullRequestList | null;
  readonly orderedEntries: ReadonlyArray<EnvironmentPullRequestEntry> | null;
  readonly authored: MergedPullRequestList | null;
  readonly reviewing: MergedPullRequestList | null;
}): RetainedPullRequestList | null {
  const snapshot = useMemo((): RetainedPullRequestList | null => {
    if (environmentKey.length === 0) return null;
    const stored = readPullRequestListSnapshot(pullRequestSnapshotStorage(), environmentKey);
    return stored === null ? null : { ...stored, environmentKey, query: "" };
  }, [environmentKey]);
  const [held, setHeld] = useState<RetainedPullRequestList | null>(null);
  const loaded = held?.environmentKey === environmentKey ? held : snapshot;
  useEffect(() => {
    const liveData = live.data;
    if (liveData === null || live.isPending) return;
    setHeld((current) => {
      const previous = current?.environmentKey === environmentKey ? current : snapshot;
      const partitions =
        authored !== null && reviewing !== null
          ? { authored: authored.entries, reviewing: reviewing.entries }
          : previous?.scope === scope
            ? previous.partitions
            : undefined;
      const data = { ...liveData, entries: orderedEntries ?? liveData.entries };
      if (environmentKey.length > 0 && query.length === 0) {
        writePullRequestListSnapshot(pullRequestSnapshotStorage(), environmentKey, {
          scope,
          data: {
            ...data,
            viewers: baseline?.viewers ?? data.viewers,
            providers: baseline?.providers ?? data.providers,
          },
          ...(partitions === undefined ? {} : { partitions }),
        });
      }
      return {
        environmentKey,
        scope,
        query,
        data,
        ...(partitions === undefined ? {} : { partitions }),
      };
    });
  }, [
    authored,
    baseline,
    environmentKey,
    live.data,
    live.isPending,
    orderedEntries,
    query,
    reviewing,
    scope,
    snapshot,
  ]);
  return loaded;
}

export interface EnvironmentQueryTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

interface MergedEnvironmentQueryView<A> {
  /** One entry per query target that has answered, in the order the targets were given. */
  readonly values: ReadonlyArray<readonly [EnvironmentId, A]>;
  /** The first environment that failed. Others may still have answered — this is not fatal. */
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * The same per-environment query read across several environments at once. React cannot subscribe
 * to a list of atoms whose length changes, so the fan-out happens inside one derived atom keyed by
 * the targets — the same shape the cross-environment thread search uses.
 *
 * An environment that fails contributes nothing rather than blanking the page: the pull request
 * list is a union, and one unreachable machine should not hide the others' rows.
 */
function createMergedEnvironmentQuery<Input, A>(
  label: string,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get): MergedEnvironmentQueryView<A> => {
      const targets = JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>;
      const values: Array<readonly [EnvironmentId, A]> = [];
      let error: string | null = null;
      let isPending = false;
      for (const target of targets) {
        const result = get(atomFor(target));
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) {
          error = formatEnvironmentQueryError(result.cause);
        }
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) values.push([target.environmentId, value]);
      }
      return { values, error, isPending };
    }).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  const empty = Atom.make<MergedEnvironmentQueryView<A>>({
    values: [],
    error: null,
    isPending: false,
  }).pipe(Atom.withLabel(`${label}:empty`));
  return function useMergedQuery(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const key = JSON.stringify(targets);
    const view = useAtomValue(targets.length === 0 ? empty : family(key));
    const refresh = useCallback(
      (override?: ReadonlyArray<EnvironmentQueryTarget<Input>>) => {
        const refreshTargets =
          override ?? (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>);
        for (const atom of new Set(refreshTargets.map(atomFor))) {
          appAtomRegistry.refresh(atom);
        }
      },
      [key],
    );
    return { ...view, refresh };
  };
}

const usePullRequestListsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list",
  (target: EnvironmentQueryTarget<PullRequestListInput>) => pullRequestEnvironment.list(target),
);

const usePullRequestStatsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list-stats",
  pullRequestEnvironment.listStats,
);

const usePullRequestTurnRefreshQuery = createMergedEnvironmentQuery(
  "web-pull-requests:turn-refreshes",
  ({ environmentId }: EnvironmentQueryTarget<Readonly<Record<string, never>>>) =>
    pullRequestEnvironment.refreshes({ environmentId, input: {} }),
);

export function usePullRequestTurnRefreshes(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<readonly [EnvironmentId, number]> {
  return usePullRequestTurnRefreshQuery(
    environmentIds.map((environmentId) => ({ environmentId, input: {} })),
  ).values;
}

export function usePullRequestTurnRefresh(environmentId: EnvironmentId): number | null {
  const result = useAtomValue(pullRequestEnvironment.refreshes({ environmentId, input: {} }));
  return Option.getOrNull(AsyncResult.value(result));
}

export interface MergedPullRequestListView {
  readonly data: MergedPullRequestList | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: (targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>) => void;
}

/** One listing per environment, merged into the single list the page renders. */
export function usePullRequestList(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>,
): MergedPullRequestListView {
  const query = usePullRequestListsQuery(targets);
  const data = useMemo(() => mergePullRequestLists(query.values), [query.values]);
  useLayoutEffect(() => {
    for (const [environmentId, result] of query.values) {
      for (const entry of result.entries) {
        pullRequestState.observeSummary(
          {
            environmentId,
            input: {
              projectId: entry.projectId,
              repository: entry.repository,
              number: entry.number,
            },
          },
          entry,
        );
      }
    }
  }, [query.values]);
  return { data, error: query.error, isPending: query.isPending, refresh: query.refresh };
}

/** The line counts for the rows on screen, asked of each environment for its own rows. */
export function usePullRequestListStats(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
): {
  readonly stats: ReadonlyArray<EnvironmentPullRequestStat> | null;
  readonly isPending: boolean;
  readonly refresh: (
    targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
  ) => void;
} {
  const query = usePullRequestStatsQuery(targets);
  const stats = useMemo(
    () =>
      query.values.length === 0
        ? null
        : query.values.flatMap(([environmentId, result]) =>
            result.stats.map((stat) => ({ ...stat, environmentId })),
          ),
    [query.values],
  );
  return { stats, isPending: query.isPending, refresh: query.refresh };
}
