import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetail,
  type PullRequestListResult,
  type PullRequestSummary,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readPullRequestDetailSnapshot,
  writePullRequestDetailSnapshot,
} from "../components/pullRequest/pullRequestDetail.logic";
import {
  narrowPullRequestsToFilters,
  readPullRequestListSnapshot,
  writePullRequestListSnapshot,
  type EnvironmentPullRequestEntry,
  type MergedPullRequestList,
} from "../components/pullRequest/pullRequestList.logic";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import {
  createPullRequestState,
  pullRequestEnvironment,
  pullRequestState,
  refreshPullRequestFromHost,
  resolveSharedThreadPullRequest,
  useObservedPullRequestEntries,
  usePullRequestDetail,
  usePullRequestList,
  useRetainedPullRequestList,
  useSharedPullRequestSummary,
  useSharedThreadPullRequest,
} from "./pullRequests";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const reference = { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 7 };
const target = { environmentId, input: reference };

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    provider: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge"],
      mergeMethods: ["merge"],
      search: true,
      review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment"] },
      reviewers: { request: true, listCandidates: true },
    },
    viewerPermissions: {
      actions: ["merge"],
      comment: true,
      resolve: true,
      verdicts: ["comment"],
      requestReviewers: true,
    },
    ...reference,
    projectTitle: "web",
    workspaceRoot: "/repo",
    title: "Open PR",
    body: "Current description",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    viewer: "reader",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    headBranch: "feature",
    baseBranch: "main",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    ...overrides,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    key: (index) => [...values.keys()][index] ?? null,
    clear: () => {
      values.clear();
    },
  };
}

function listEntry(
  overrides: Partial<EnvironmentPullRequestEntry> = {},
): EnvironmentPullRequestEntry {
  return {
    ...detail(),
    environmentId,
    host: "github.com",
    viewerReviewRequested: true,
    ...overrides,
  };
}

function list(entries: ReadonlyArray<EnvironmentPullRequestEntry>): MergedPullRequestList {
  return {
    entries,
    viewers: { [`${environmentId} github.com`]: "reader" },
    providers: [],
    errors: [],
    truncated: false,
    nextCursors: {},
    truncatedEnvironments: [],
  };
}

describe("scoped pull request state", () => {
  let registry: AtomRegistry.AtomRegistry;
  let storage: Storage;
  const revised = vi.fn();
  let state: ReturnType<typeof createPullRequestState>;

  beforeEach(() => {
    registry = AtomRegistry.make();
    storage = memoryStorage();
    revised.mockReset();
    state = createPullRequestState(registry, {
      storage: () => storage,
      onRevisionChanged: revised,
    });
  });
  afterEach(() => registry.dispose());

  it("retains newer detail and a confirmed merge when an older response arrives", () => {
    const current = detail({
      title: "Merged PR",
      state: "merged",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    state.observeDetail(target, current);
    state.observeDetail(target, detail({ body: "Old description" }));
    expect(registry.get(state.snapshot(target)).detail).toBe(current);
    expect(registry.get(state.snapshot(target)).summary?.state).toBe("merged");
    expect(readPullRequestDetailSnapshot(storage, environmentId, reference)?.title).toBe(
      "Merged PR",
    );
    expect(revised).not.toHaveBeenCalled();
  });

  it("can hydrate detail from an object already observed as a summary", () => {
    const current = detail();
    state.observeSummary(target, current);
    state.observeDetail(target, current);
    expect(registry.get(state.snapshot(target)).detail).toBe(current);
  });

  it.each([false, true])(
    "confirms equal-time detail conflicts with fresh draft=%s",
    async (isDraft) => {
      const fresh = detail({ isDraft });
      let confirm = (_value: PullRequestDetail | null) => {};
      const answer = new Promise<PullRequestDetail | null>((resolve) => {
        confirm = resolve;
      });
      const readFreshDetail = vi.fn(() => answer);
      state = createPullRequestState(registry, {
        storage: () => storage,
        onRevisionChanged: revised,
        readFreshDetail,
      });
      state.observeSummary(target, detail({ isDraft: !isDraft }));
      state.observeDetail(target, fresh);
      state.observeDetail(target, { ...fresh });
      expect(registry.get(state.snapshot(target)).summary?.isDraft).toBe(!isDraft);
      expect(registry.get(state.snapshot(target)).detail?.body).toBe(fresh.body);
      expect(readFreshDetail).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal));
      confirm(fresh);
      await answer;
      expect(registry.get(state.snapshot(target)).summary?.isDraft).toBe(isDraft);
    },
  );

  it("does not let a conflict confirmation undo a newer summary", async () => {
    let confirm = (_value: PullRequestDetail | null) => {};
    const answer = new Promise<PullRequestDetail | null>((resolve) => {
      confirm = resolve;
    });
    state = createPullRequestState(registry, {
      storage: () => storage,
      onRevisionChanged: revised,
      readFreshDetail: () => answer,
    });
    state.observeSummary(target, detail({ isDraft: false }));
    state.observeDetail(target, detail({ isDraft: true }));
    state.observeSummary(
      target,
      detail({ title: "Later title", isDraft: false, updatedAt: "2026-09-03T00:00:00.000Z" }),
    );
    confirm(detail({ isDraft: true }));
    await answer;
    expect(registry.get(state.snapshot(target)).summary?.title).toBe("Later title");
    expect(registry.get(state.snapshot(target)).summary?.isDraft).toBe(false);
  });

  it("confirms an unseen old summary without undoing accepted detail", async () => {
    const fresh = detail({ isDraft: false });
    const answer = Promise.resolve(fresh);
    const readFreshDetail = vi.fn(() => answer);
    state = createPullRequestState(registry, {
      storage: () => storage,
      onRevisionChanged: revised,
      readFreshDetail,
    });
    state.observeDetail(target, fresh);
    state.observeSummary(target, detail({ isDraft: true }));
    expect(registry.get(state.snapshot(target)).summary?.isDraft).toBe(false);
    await answer;
    expect(registry.get(state.snapshot(target)).summary?.isDraft).toBe(false);
    expect(readFreshDetail).toHaveBeenCalledOnce();
  });

  it("finds a saved detail written with different repository casing", () => {
    writePullRequestDetailSnapshot(
      storage,
      environmentId,
      { ...reference, repository: "ACME/Web" },
      detail({ state: "merged" }),
    );
    expect(
      registry.get(state.summaryByUrl(environmentId, reference.projectId, detail().url))?.state,
    ).toBe("merged");
  });

  it("aborts conflict confirmation on reset and rejects its late answer", async () => {
    let confirm = (_value: PullRequestDetail | null) => {};
    const answer = new Promise<PullRequestDetail | null>((resolve) => {
      confirm = resolve;
    });
    const readFreshDetail = vi.fn((_target: typeof target, _signal: AbortSignal) => answer);
    state = createPullRequestState(registry, {
      storage: () => storage,
      onRevisionChanged: revised,
      readFreshDetail,
    });
    state.observeSummary(target, detail({ isDraft: false }));
    state.observeDetail(target, detail({ isDraft: true }));
    const signal = readFreshDetail.mock.calls[0]![1];
    registry.reset();
    expect(signal.aborted).toBe(true);
    confirm(detail({ isDraft: true }));
    await answer;
    expect(registry.get(state.snapshot(target)).summary?.isDraft).toBe(false);
    state.observeDetail(target, detail({ isDraft: true }));
    expect(readFreshDetail).toHaveBeenCalledTimes(2);
  });

  it("stores summary fields without copying detail permissions or content", () => {
    const current = detail();
    state.observeDetail(target, current);
    state.observeSummary(
      target,
      detail({
        title: "New title",
        updatedAt: "2026-09-03T00:00:00.000Z",
        body: "A summary must not replace the body",
        viewer: "another-reader",
        viewerPermissions: { ...current.viewerPermissions, actions: [] },
      }),
    );
    const snapshot = registry.get(state.snapshot(target));
    expect(snapshot.detail).toBe(current);
    expect(snapshot.summary?.title).toBe("New title");
    expect(snapshot.summary).not.toHaveProperty("body");
    expect(snapshot.summary).not.toHaveProperty("viewerPermissions");
    const persisted = readPullRequestDetailSnapshot(storage, environmentId, reference);
    expect(persisted?.observedSummary?.title).toBe("New title");
    expect(persisted?.updatedAt).toBe(current.updatedAt);
    expect(persisted?.body).toBe(current.body);
    expect(persisted?.viewer).toBe(current.viewer);
    expect(persisted?.viewerPermissions).toEqual(current.viewerPermissions);
  });

  it("refreshes once per accepted revision and accepts later merged metadata", () => {
    const first = detail({ state: "merged" });
    state.observeDetail(target, first);
    const next = detail({
      state: "merged",
      title: "Updated after merge",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    state.observeSummary(target, next);
    state.observeSummary(target, next);
    state.observeDetail(target, next);
    state.observeSummary(target, first);
    expect(registry.get(state.snapshot(target)).summary?.title).toBe(next.title);
    expect(registry.get(state.snapshot(target)).revision).toBe(1);
    expect(revised).toHaveBeenCalledExactlyOnceWith(target);
    state.invalidate(target);
    expect(registry.get(state.snapshot(target)).revision).toBe(2);
  });

  it("keeps detail and summary timestamps separate across a reload", () => {
    state.observeDetail(target, detail({ body: "Body A" }));
    state.observeSummary(
      target,
      detail({ title: "Latest title", updatedAt: "2026-09-04T00:00:00.000Z" }),
    );
    registry.reset();
    state.observeDetail(target, detail({ body: "Body B", updatedAt: "2026-09-03T00:00:00.000Z" }));
    const snapshot = registry.get(state.snapshot(target));
    expect(snapshot.detail?.body).toBe("Body B");
    expect(snapshot.detail?.updatedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(snapshot.summary?.title).toBe("Latest title");
    const stored = readPullRequestDetailSnapshot(storage, environmentId, reference);
    expect(stored?.updatedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(stored?.observedSummary?.updatedAt).toBe("2026-09-04T00:00:00.000Z");
  });

  it("keeps the current viewer's permissions even when the PR timestamp goes backward", () => {
    state.observeDetail(target, detail({ updatedAt: "2026-09-04T00:00:00.000Z" }));
    const currentViewer = detail({
      viewer: "new-reader",
      viewerPermissions: {
        actions: [],
        comment: false,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      },
    });
    state.observeDetail(target, currentViewer);
    expect(registry.get(state.snapshot(target)).detail?.viewer).toBe("new-reader");
    expect(registry.get(state.snapshot(target)).detail?.viewerPermissions.actions).toEqual([]);
  });

  it("retains optional summary fields from older servers and accepts explicit reopen values", () => {
    const closedAt = "2026-09-02T00:00:00.000Z";
    state.observeDetail(target, detail({ state: "closed", isDraft: true, closedAt }));
    state.observeSummary(target, {
      ...detail({ state: "closed", updatedAt: "2026-09-03T00:00:00.000Z" }),
      isDraft: undefined,
      closedAt: undefined,
      mergedAt: undefined,
    });
    expect(registry.get(state.snapshot(target)).summary?.isDraft).toBe(true);
    expect(registry.get(state.snapshot(target)).summary?.closedAt).toBe(closedAt);
    state.observeSummary(target, detail({ isDraft: false, updatedAt: "2026-09-04T00:00:00.000Z" }));
    expect(registry.get(state.snapshot(target)).summary?.isDraft).toBe(false);
    expect(registry.get(state.snapshot(target)).summary?.closedAt).toBeNull();
  });

  it("shares a merge with a detected PR but not another environment, project, or host", () => {
    const merged = detail({ state: "merged" });
    state.observeDetail(target, merged);
    const observed = registry.get(
      state.summaryByUrl(environmentId, reference.projectId, merged.url),
    );
    const detected: NonNullable<VcsStatusResult["pr"]> = {
      number: 7,
      title: "Open PR",
      url: merged.url,
      baseRef: "main",
      headRef: "feature",
      state: "open",
    };
    expect(resolveSharedThreadPullRequest(detected, observed)?.state).toBe("merged");
    expect(
      registry.get(state.summaryByUrl(otherEnvironmentId, reference.projectId, merged.url)),
    ).toBeNull();
    expect(
      registry.get(state.summaryByUrl(environmentId, ProjectId.make("other-project"), merged.url)),
    ).toBeNull();
    expect(
      resolveSharedThreadPullRequest(
        { ...detected, url: "https://github.enterprise.test/acme/web/pull/7" },
        observed,
      )?.state,
    ).toBe("open");
  });

  it("keeps newer merged VCS metadata when a merged summary is older", () => {
    const current: NonNullable<VcsStatusResult["pr"]> = {
      number: 7,
      title: "New title",
      url: detail().url,
      baseRef: "main",
      headRef: "feature",
      state: "merged",
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    expect(resolveSharedThreadPullRequest(current, detail({ state: "merged" }))).toBe(current);
    expect(
      resolveSharedThreadPullRequest(
        current,
        detail({ state: "merged", title: "Latest title", updatedAt: "2026-09-05T00:00:00.000Z" }),
      )?.title,
    ).toBe("Latest title");
  });

  it("rehydrates accepted state after registry disposal and tolerates denied storage access", () => {
    state.observeDetail(target, detail());
    state.observeSummary(
      target,
      detail({ state: "merged", updatedAt: "2026-09-03T00:00:00.000Z" }),
    );
    registry.reset();
    // The detected sidebar has only a URL and must not depend on another reader mounting first.
    expect(
      registry.get(
        state.summaryByUrl(
          environmentId,
          reference.projectId,
          "https://GITHUB.com/ACME/WEB/pull/7/?view=checks#top",
        ),
      )?.state,
    ).toBe("merged");
    expect(
      registry.get(
        state.summaryByUrl(
          environmentId,
          reference.projectId,
          "https://github.enterprise.test/acme/web/pull/7",
        ),
      ),
    ).toBeNull();
    expect(registry.get(state.snapshot(target)).summary?.state).toBe("merged");
    expect(
      registry.get(state.snapshot({ ...target, environmentId: otherEnvironmentId })).detail,
    ).toBeNull();
    const denied = createPullRequestState(registry, {
      storage: () => {
        throw new Error("Storage denied");
      },
      onRevisionChanged: revised,
    });
    denied.observeDetail(target, detail());
    expect(registry.get(denied.snapshot(target)).detail?.title).toBe("Open PR");
  });
});

function retainedDetailQuery() {
  let current: AsyncResult.AsyncResult<PullRequestDetail> = AsyncResult.initial();
  return Atom.writable(
    () => current,
    (context, value: AsyncResult.AsyncResult<PullRequestDetail>) => {
      current = value;
      context.setSelf(value);
    },
  ).pipe(Atom.keepAlive);
}

describe("pull request readers", () => {
  let renderer: ReactTestRenderer | undefined;
  let latest: ReturnType<typeof usePullRequestDetail>;
  let linked: PullRequestSummary | null;
  let linkedQuery: PullRequestSummary | null;
  let detected: VcsStatusResult["pr"];
  let paints: Array<{ environmentId: EnvironmentId; title: string | null }>;
  let queries = Atom.family((_key: string) => retainedDetailQuery());

  function Probe({ selected }: { selected: EnvironmentId }) {
    const current = usePullRequestDetail({ environmentId: selected, input: reference });
    const currentLinked = useSharedPullRequestSummary(
      selected,
      { ...reference, ...(linkedQuery === null ? {} : { url: linkedQuery.url }) },
      linkedQuery,
    );
    const currentDetected = useSharedThreadPullRequest(selected, reference.projectId, {
      number: reference.number,
      url: detail().url,
      title: "Open PR",
      state: "open",
      baseRef: "main",
      headRef: "feature",
    });
    useLayoutEffect(() => {
      latest = current;
      linked = currentLinked;
      detected = currentDetected;
      paints.push({ environmentId: selected, title: current.data?.title ?? null });
    }, [current, currentLinked, currentDetected, selected]);
    return null;
  }

  const render = (selected: EnvironmentId) => (
    <AppAtomRegistryProvider>
      <Probe selected={selected} />
    </AppAtomRegistryProvider>
  );

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    appAtomRegistry.reset();
    paints = [];
    linkedQuery = null;
    queries = Atom.family((_key: string) => retainedDetailQuery());
    vi.spyOn(pullRequestEnvironment.invalidate, "run").mockResolvedValue(
      AsyncResult.success(undefined),
    );
    vi.spyOn(pullRequestEnvironment, "detail").mockImplementation(({ environmentId }) =>
      queries(environmentId),
    );
    vi.spyOn(pullRequestEnvironment, "activity").mockReturnValue(Atom.make(AsyncResult.initial()));
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
    appAtomRegistry.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("never renders or publishes the previous environment's snapshot after a switch", async () => {
    writePullRequestDetailSnapshot(
      window.localStorage,
      environmentId,
      reference,
      detail({ title: "First environment" }),
    );
    await act(() => {
      renderer = create(render(environmentId));
    });
    expect(latest.data?.title).toBe("First environment");
    paints = [];
    await act(() => renderer?.update(render(otherEnvironmentId)));
    expect(paints.length).toBeGreaterThan(0);
    expect(
      paints.every((paint) => paint.environmentId === otherEnvironmentId && paint.title === null),
    ).toBe(true);
    expect(linked).toBeNull();
    expect(
      appAtomRegistry.get(
        pullRequestState.snapshot({ ...target, environmentId: otherEnvironmentId }),
      ).summary,
    ).toBeNull();
  });

  it("updates detail, linked, and detected readers from one confirmed merge", async () => {
    await act(() => {
      renderer = create(render(environmentId));
    });
    await act(() => appAtomRegistry.set(queries(environmentId), AsyncResult.success(detail())));
    await act(() =>
      appAtomRegistry.set(
        queries(environmentId),
        AsyncResult.success(
          detail({ state: "merged", title: "Merged PR", updatedAt: "2026-09-03T00:00:00.000Z" }),
        ),
      ),
    );
    expect(latest.data?.state).toBe("merged");
    expect(linked?.state).toBe("merged");
    expect(detected?.state).toBe("merged");
    await act(() => appAtomRegistry.set(queries(environmentId), AsyncResult.success(detail())));
    expect(latest.data?.state).toBe("merged");
    expect(latest.data?.title).toBe("Merged PR");
    expect(detected?.state).toBe("merged");
  });

  it("does not republish a held linked summary when detail changes at the same timestamp", async () => {
    linkedQuery = detail({ isDraft: true });
    await act(() => {
      renderer = create(render(environmentId));
    });
    await act(async () => {
      appAtomRegistry.set(queries(environmentId), AsyncResult.success(detail({ isDraft: false })));
    });
    expect(latest.data?.isDraft).toBe(false);
    expect(linked?.isDraft).toBe(false);
    expect(appAtomRegistry.get(pullRequestState.snapshot(target)).summary?.isDraft).toBe(false);
    await act(() => renderer?.unmount());
    await act(() => {
      renderer = create(render(environmentId));
    });
    expect(linked?.isDraft).toBe(false);
  });

  it("does not let held detail undo a same-timestamp summary update", async () => {
    let invalidate = () => {};
    vi.mocked(pullRequestEnvironment.invalidate.run).mockReturnValueOnce(
      new Promise((resolve) => {
        invalidate = () => resolve(AsyncResult.success(undefined));
      }),
    );
    const held = detail({ isDraft: true });
    await act(() => {
      renderer = create(render(environmentId));
    });
    await act(() => appAtomRegistry.set(queries(environmentId), AsyncResult.success(held)));
    await act(() => pullRequestState.observeSummary(target, detail({ isDraft: false })));
    // Conflicting equal timestamps keep the accepted state until a fresh host answer arrives.
    expect(latest.data?.isDraft).toBe(true);
    await act(async () => {
      appAtomRegistry.set(queries(environmentId), AsyncResult.success(detail({ isDraft: false })));
      invalidate();
    });
    expect(latest.data?.isDraft).toBe(false);
    expect(linked?.isDraft).toBe(false);
    await act(() => appAtomRegistry.set(queries(environmentId), AsyncResult.success(held)));
    await act(() => renderer?.unmount());
    await act(() => {
      renderer = create(render(environmentId));
    });
    expect(latest.data?.isDraft).toBe(false);
  });

  it("does not let a mounted old-host linked summary replace current detail", async () => {
    linkedQuery = detail({ title: "Old host" });
    await act(() => {
      renderer = create(render(environmentId));
    });
    const currentHost = detail({
      title: "Current host",
      url: "https://github.enterprise.test/acme/web/pull/7",
    });
    await act(() => appAtomRegistry.set(queries(environmentId), AsyncResult.success(currentHost)));
    expect(latest.data?.title).toBe("Current host");
    expect(appAtomRegistry.get(pullRequestState.snapshot(target)).detail).toBe(currentHost);
    await act(() => pullRequestState.observeSummary(target, detail({ state: "merged" })));
    expect(appAtomRegistry.get(pullRequestState.snapshot(target)).detail).toBe(currentHost);
  });

  it("invalidates the selected host before re-reading and keeps a later environment switch separate", async () => {
    let finishInvalidation = () => {};
    const invalidation = new Promise<
      Awaited<ReturnType<typeof pullRequestEnvironment.invalidate.run>>
    >((resolve) => {
      finishInvalidation = () => resolve(AsyncResult.success(undefined));
    });
    vi.spyOn(pullRequestEnvironment.invalidate, "run").mockReturnValue(invalidation);
    await act(() => {
      renderer = create(render(environmentId));
    });
    const refresh = refreshPullRequestFromHost(target);
    expect(appAtomRegistry.get(pullRequestState.snapshot(target)).revision).toBe(0);
    await act(() => renderer?.update(render(otherEnvironmentId)));
    await act(async () => {
      finishInvalidation();
      await refresh;
    });
    expect(appAtomRegistry.get(pullRequestState.snapshot(target)).revision).toBe(1);
    expect(latest.revision).toBe(0);
  });

  it("applies observed state before list filters without changing host or viewer fields", async () => {
    const rows = [listEntry(), listEntry({ environmentId: otherEnvironmentId })];
    let shown: ReadonlyArray<EnvironmentPullRequestEntry> = [];
    function ListProbe() {
      const entries = useObservedPullRequestEntries(rows);
      useLayoutEffect(() => {
        shown = entries;
      }, [entries]);
      return null;
    }
    await act(() => {
      renderer = create(
        <AppAtomRegistryProvider>
          <ListProbe />
        </AppAtomRegistryProvider>,
      );
    });
    await act(() =>
      pullRequestState.observeSummary(
        target,
        detail({ state: "merged", updatedAt: "2026-09-03T00:00:00.000Z" }),
      ),
    );
    expect(shown[0]?.state).toBe("merged");
    expect(shown[0]?.host).toBe("github.com");
    expect(shown[0]?.viewerReviewRequested).toBe(true);
    expect(shown[1]).toBe(rows[1]);
    expect(
      narrowPullRequestsToFilters(shown, { state: "open", projectId: undefined, host: undefined }),
    ).toEqual([rows[1]]);
  });

  it("does not replay a held list answer when another environment answers or refresh starts", async () => {
    const lists = Atom.family((_key: string) =>
      Atom.make<AsyncResult.AsyncResult<PullRequestListResult>>(AsyncResult.initial()),
    );
    vi.spyOn(pullRequestEnvironment, "list").mockImplementation(({ environmentId }) =>
      lists(environmentId),
    );
    const first: PullRequestListResult = {
      entries: [listEntry({ state: "closed", isDraft: true })],
      viewers: {},
      providers: [],
      errors: [],
      truncated: false,
      nextCursors: {},
    };
    function ListProbe() {
      usePullRequestList([
        { environmentId, input: { state: "all" } },
        { environmentId: otherEnvironmentId, input: { state: "all" } },
      ]);
      return <Probe selected={environmentId} />;
    }
    await act(() => {
      appAtomRegistry.set(lists(environmentId), AsyncResult.success(first));
      renderer = create(
        <AppAtomRegistryProvider>
          <ListProbe />
        </AppAtomRegistryProvider>,
      );
    });
    await act(async () => {
      appAtomRegistry.set(
        queries(environmentId),
        AsyncResult.success(detail({ state: "open", isDraft: false })),
      );
    });
    await act(() =>
      appAtomRegistry.set(
        lists(otherEnvironmentId),
        AsyncResult.success({ ...first, entries: [] }),
      ),
    );
    expect(latest.data?.state).toBe("open");
    expect(latest.data?.isDraft).toBe(false);
    await act(() =>
      appAtomRegistry.set(lists(environmentId), AsyncResult.success(first, { waiting: true })),
    );
    expect(latest.data?.state).toBe("open");
    expect(latest.data?.isDraft).toBe(false);
  });

  it("hydrates only the selected environment's list and does not persist search results", async () => {
    const saved = list([listEntry()]);
    writePullRequestListSnapshot(window.localStorage, environmentId, { scope: "all", data: saved });
    const held: { current: ReturnType<typeof useRetainedPullRequestList> } = { current: null };
    const renderedTitles: Array<string | undefined> = [];
    function ListProbe({
      selected,
      live = null,
      query = "",
    }: {
      selected: EnvironmentId;
      live?: MergedPullRequestList | null;
      query?: string;
    }) {
      const current = useRetainedPullRequestList({
        environmentKey: selected,
        scope: "all",
        query,
        live: { data: live, isPending: live === null },
        baseline: null,
        orderedEntries: null,
        authored: null,
        reviewing: null,
      });
      useLayoutEffect(() => {
        held.current = current;
        renderedTitles.push(current?.data.entries[0]?.title);
      }, [current]);
      return null;
    }
    await act(() => {
      renderer = create(<ListProbe selected={environmentId} />);
    });
    expect(held.current?.data.entries[0]?.title).toBe("Open PR");
    renderedTitles.length = 0;
    await act(() => renderer?.update(<ListProbe selected={otherEnvironmentId} />));
    expect(renderedTitles.every((title) => title === undefined)).toBe(true);
    const searchResult = list([listEntry({ title: "Search result" })]);
    await act(() =>
      renderer?.update(<ListProbe selected={environmentId} live={searchResult} query="search" />),
    );
    expect(held.current?.data.entries[0]?.title).toBe("Search result");
    expect(
      readPullRequestListSnapshot(window.localStorage, environmentId)?.data.entries[0]?.title,
    ).toBe("Open PR");
  });
});
