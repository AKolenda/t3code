import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { GitManager } from "../git/GitManager.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadSettlementReactor from "./ThreadSettlementReactor.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");
const LINKED_PROJECT_ID = ProjectId.make("linked-settlement-project");

type AutoSettleCommand = Extract<OrchestrationCommand, { readonly type: "thread.auto-settle" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(
  id: ProjectId = PROJECT_ID,
  workspaceRoot = "/workspace/project",
): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects,
    threads,
    updatedAt: NOW,
  };
}

function makeLink(
  number: number,
  snapshot: Partial<ThreadPullRequestSnapshot> | null = {},
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "owner/repository",
    number,
    url: `https://github.com/owner/repository/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      snapshot === null
        ? null
        : {
            state: "open",
            title: `Pull request ${number}`,
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: NOW,
            syncedAt: NOW,
            ...snapshot,
          },
    stack: null,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly settings?: ServerSettings;
  readonly branchPullRequest?: GitManager["Service"]["branchPullRequest"];
  readonly onDispatch?: (
    command: AutoSettleCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const branchCalls = yield* Ref.make<
    ReadonlyArray<{ readonly cwd: string; readonly branch: string }>
  >([]);
  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const branchPullRequest: GitManager["Service"]["branchPullRequest"] = (input) =>
    Ref.update(branchCalls, (calls) => [...calls, input]).pipe(
      Effect.andThen(options.branchPullRequest?.(input) ?? Effect.succeed(null)),
    );

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1 }),
    );
  };

  const serverSettings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings),
    updateSettings,
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Ref.updateAndGet(snapshotReadCount, (count) => count + 1).pipe(
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
        ),
    }),
    Layer.mock(GitManager)({ branchPullRequest }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  return {
    activation,
    snapshots,
    snapshotReadCount,
    snapshotReads,
    commands,
    branchCalls,
    updateSettings,
    layer: ThreadSettlementReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementReactor.ThreadSettlementReactor["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

describe("ThreadSettlementReactor", () => {
  it.effect("starts without clients and skips protected threads before pull request lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const skipped = [
          makeThread("pending-approval", {
            branch: "skip-approval",
            hasPendingApprovals: true,
          }),
          makeThread("snoozed", {
            branch: "skip-snoozed",
            snoozedUntil: "2026-08-29T00:00:00.000Z",
          }),
        ];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("inactive", { branch: "inactive-feature" }),
            makeThread("closed-pr", {
              branch: "closed-feature",
              pullRequests: [makeLink(42, { state: "closed" })],
            }),
            ...skipped,
          ]),
          branchPullRequest: () => Effect.succeed(null),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 0);

          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          const commands = yield* Ref.get(fixture.commands);
          assert.deepStrictEqual(
            commands
              .map(({ threadId, snapshotSequence }) => ({ threadId, snapshotSequence }))
              .sort((left, right) => left.threadId.localeCompare(right.threadId)),
            [
              {
                threadId: ThreadId.make("closed-pr"),
                snapshotSequence: 1,
              },
              {
                threadId: ThreadId.make("inactive"),
                snapshotSequence: 1,
              },
            ],
          );
          // The linked thread decided from its synced snapshot, without a host or git lookup.
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), [
            { cwd: "/workspace/project", branch: "inactive-feature" },
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reevaluates inactivity and pull request state once per minute", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const pullRequest = yield* Ref.make<"open" | "merged">("open");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("at-boundary", {
              latestUserMessageAt: "2026-08-25T12:00:00.000Z",
            }),
            makeThread("open-pr", {
              branch: "saved-feature",
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
            }),
          ]),
          branchPullRequest: () =>
            Ref.get(pullRequest).pipe(Effect.map((state) => ({ state, updatedAt: NOW }))),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* Ref.set(pullRequest, "merged");
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands))
              .map((command) => command.threadId)
              .sort((left, right) => left.localeCompare(right)),
            [ThreadId.make("at-boundary"), ThreadId.make("open-pr")],
          );
          assert.strictEqual((yield* Ref.get(fixture.branchCalls)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("uses fresh settlement settings after lookup and ignores unrelated changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<"merged" | "closed">("merged");
        const firstLookupStarted = yield* Deferred.make<void>();
        const releaseFirstLookup = yield* Deferred.make<void>();
        const laterLookupStarted = yield* Deferred.make<void>();
        const releaseLaterLookup = yield* Deferred.make<void>();
        const lookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("settings-thread", { branch: "saved-feature" })]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
          branchPullRequest: () =>
            Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 1
                  ? Deferred.succeed(firstLookupStarted, undefined)
                  : count === 3
                    ? Deferred.succeed(laterLookupStarted, undefined)
                    : Effect.void,
              ),
              Effect.tap((count) =>
                count === 1
                  ? Deferred.await(releaseFirstLookup)
                  : count === 3
                    ? Deferred.await(releaseLaterLookup)
                    : Effect.void,
              ),
              Effect.andThen(Ref.get(state)),
              Effect.map((pullRequestState) => ({ state: pullRequestState, updatedAt: NOW })),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* Deferred.await(firstLookupStarted);

          yield* fixture.updateSettings({ sidebarAutoSettleOnMerge: false });
          yield* Deferred.succeed(releaseFirstLookup, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 2);

          yield* Ref.set(state, "closed");
          yield* fixture.updateSettings({ enableAgentBrowserAccess: false });
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
          yield* Deferred.await(laterLookupStarted);
          yield* Deferred.succeed(releaseLaterLookup, undefined);
          yield* reactor.drain;

          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 3);
          assert.strictEqual(yield* Ref.get(lookupCount), 3);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("settings-thread")],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps linked threads active while any link is open or not yet synced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("open-link", {
              branch: "saved-feature",
              pullRequests: [makeLink(9, { state: "merged" }), makeLink(10, { state: "open" })],
            }),
            makeThread("unsynced-link", {
              branch: "saved-feature",
              pullRequests: [makeLink(11, null)],
            }),
            makeThread("dismissed-only", {
              pullRequests: [makeLink(12, { state: "open" }, { source: "stack-dismissed" })],
            }),
            makeThread("inactive-without-pr"),
          ]),
          branchPullRequest: () => Effect.succeed({ state: "merged", updatedAt: NOW }),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands))
              .map((command) => command.threadId)
              .sort((left, right) => left.localeCompare(right)),
            [ThreadId.make("dismissed-only"), ThreadId.make("inactive-without-pr")],
          );
          // Linked threads never consult git; the tombstone-only thread has no links to read.
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles a thread once every linked pull request is terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("stack-merged", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              pullRequests: [
                makeLink(20, { state: "merged", updatedAt: "2026-08-26T00:00:00.000Z" }),
                makeLink(21, { state: "merged", updatedAt: "2026-08-27T06:00:00.000Z" }),
              ],
            }),
            makeThread("single-merged", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              pullRequests: [makeLink(22, { state: "merged", updatedAt: NOW })],
            }),
          ]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands))
              .map((command) => command.threadId)
              .sort((left, right) => left.localeCompare(right)),
            [ThreadId.make("single-merged"), ThreadId.make("stack-merged")],
          );
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps threads active when their project is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [makeThread("missing-branch-project", { branch: "saved-feature" })],
            [makeProject(LINKED_PROJECT_ID, "/workspace/linked")],
          ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("deduplicates saved-branch lookups and reads linked threads from snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("branch-one", {
                branch: "saved-feature",
                worktreePath: "/deleted/worktree-one",
              }),
              makeThread("branch-two", {
                branch: "saved-feature",
                worktreePath: "/deleted/worktree-two",
              }),
              makeThread("linked-one", { pullRequests: [makeLink(77, { state: "merged" })] }),
              makeThread("linked-two", { pullRequests: [makeLink(77, { state: "merged" })] }),
            ],
            [makeProject(PROJECT_ID, "/workspace/project-root")],
          ),
          branchPullRequest: () => Effect.succeed({ state: "closed", updatedAt: NOW }),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), [
            { cwd: "/workspace/project-root", branch: "saved-feature" },
          ]);
          assert.deepStrictEqual(
            new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
            new Set([
              ThreadId.make("branch-one"),
              ThreadId.make("branch-two"),
              ThreadId.make("linked-one"),
              ThreadId.make("linked-two"),
            ]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("carries the snapshot guard and survives a stale dispatch rejection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("stale"), makeThread("next-candidate")]),
          onDispatch: (command) =>
            command.threadId === ThreadId.make("stale")
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "thread changed after settlement evaluation",
                  }),
                )
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          const firstSweep = yield* Ref.get(fixture.commands);
          assert.strictEqual(
            firstSweep.find((command) => command.threadId === ThreadId.make("stale"))
              ?.snapshotSequence,
            1,
          );
          assert.strictEqual(
            firstSweep.some((command) => command.threadId === ThreadId.make("next-candidate")),
            true,
          );

          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 4);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
