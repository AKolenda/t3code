import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  legacyLinkedPullRequestOf,
  resolveThreadCurrentPullRequest,
  resolveThreadPullRequestChains,
  threadPullRequestKeysEqual,
} from "./threadPullRequests.ts";

function snapshot(input: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Change",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    syncedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function link(
  number: number,
  input: Partial<Omit<ThreadPullRequestLink, "number">> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: `2026-01-01T00:00:${String(number).padStart(2, "0")}.000Z`,
    snapshot: null,
    stack: null,
    ...input,
  };
}

describe("threadPullRequestKeysEqual", () => {
  it("ignores host and repository case", () => {
    expect(
      threadPullRequestKeysEqual(
        { host: "GitHub.com", repository: "PingDotGG/t3code", number: 1 },
        { host: "github.com", repository: "pingdotgg/t3code", number: 1 },
      ),
    ).toBe(true);
    expect(
      threadPullRequestKeysEqual(
        { host: "github.com", repository: "pingdotgg/t3code", number: 1 },
        { host: "gitlab.com", repository: "pingdotgg/t3code", number: 1 },
      ),
    ).toBe(false);
  });
});

describe("resolveThreadCurrentPullRequest", () => {
  it("returns null with no visible links", () => {
    expect(resolveThreadCurrentPullRequest([])).toBeNull();
    expect(resolveThreadCurrentPullRequest([link(1, { source: "stack-dismissed" })])).toBeNull();
  });

  it("treats an unsynced link as open", () => {
    expect(resolveThreadCurrentPullRequest([link(1)])).toMatchObject({
      kind: "single",
      link: { number: 1 },
    });
  });

  it("prefers the single open link over terminal ones", () => {
    const current = resolveThreadCurrentPullRequest([
      link(1, { snapshot: snapshot({ state: "merged" }) }),
      link(2, { snapshot: snapshot({ state: "open" }) }),
      link(3, { snapshot: snapshot({ state: "closed" }) }),
    ]);
    expect(current).toMatchObject({ kind: "single", link: { number: 2 } });
  });

  it("reports a stack when several links are open and puts the highest layer on top", () => {
    const stack = {
      kind: "native" as const,
      id: "s1",
      number: 1,
      url: "https://github.com/pingdotgg/t3code/stacks/1",
      base: "main",
      layers: [
        { number: 10, headBranch: "a", state: "open" as const },
        { number: 11, headBranch: "b", state: "open" as const },
      ],
    };
    const current = resolveThreadCurrentPullRequest([
      link(11, { snapshot: snapshot(), stack }),
      link(10, { snapshot: snapshot(), stack }),
    ]);
    expect(current).toMatchObject({ kind: "stack", top: { number: 11 } });
    if (current?.kind === "stack") {
      expect(current.open.map((entry) => entry.number)).toEqual([11, 10]);
    }
  });

  it("orders an open set without stack data by most recent link", () => {
    const current = resolveThreadCurrentPullRequest([link(1), link(2)]);
    expect(current).toMatchObject({ kind: "stack", top: { number: 2 } });
  });

  it("falls back to the most recently updated terminal link", () => {
    const current = resolveThreadCurrentPullRequest([
      link(1, { snapshot: snapshot({ state: "merged", updatedAt: "2026-01-03T00:00:00.000Z" }) }),
      link(2, { snapshot: snapshot({ state: "closed", updatedAt: "2026-01-02T00:00:00.000Z" }) }),
    ]);
    expect(current).toMatchObject({ kind: "single", link: { number: 1 } });
  });
});

describe("legacyLinkedPullRequestOf", () => {
  it("projects the current link into the old shape with the thread's project", () => {
    expect(legacyLinkedPullRequestOf([link(7)], "project-1" as never)).toEqual({
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 7,
      url: "https://github.com/pingdotgg/t3code/pull/7",
    });
    expect(legacyLinkedPullRequestOf([], "project-1" as never)).toBeNull();
  });
});

describe("resolveThreadPullRequestChains", () => {
  it("chains links by base → head within a repository, bottom to top", () => {
    const chains = resolveThreadPullRequestChains([
      link(3, { snapshot: snapshot({ headBranch: "c", baseBranch: "b" }) }),
      link(1, { snapshot: snapshot({ headBranch: "a", baseBranch: "main" }) }),
      link(2, { snapshot: snapshot({ headBranch: "b", baseBranch: "a" }) }),
      link(9, { snapshot: snapshot({ headBranch: "solo", baseBranch: "main" }) }),
    ]);
    expect(chains.map((chain) => [chain.kind, chain.layers.map((layer) => layer.number)])).toEqual([
      ["derived", [1, 2, 3]],
      ["derived", [9]],
    ]);
  });

  it("uses the native stack order when the host provides one", () => {
    const stack = {
      kind: "native" as const,
      id: "s1",
      number: 1,
      url: "https://github.com/pingdotgg/t3code/stacks/1",
      base: "main",
      layers: [
        { number: 5, headBranch: "a", state: "merged" as const },
        { number: 6, headBranch: "b", state: "open" as const },
      ],
    };
    const chains = resolveThreadPullRequestChains([
      link(6, { snapshot: snapshot({ headBranch: "b", baseBranch: "main" }), stack }),
      link(5, {
        snapshot: snapshot({ state: "merged", headBranch: "a", baseBranch: "main" }),
        stack,
      }),
      link(8),
    ]);
    expect(chains.map((chain) => [chain.kind, chain.layers.map((layer) => layer.number)])).toEqual([
      ["native", [5, 6]],
      ["derived", [8]],
    ]);
  });
});
