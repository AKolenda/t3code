// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CommandId,
  CheckpointRef,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as TurnCheckpointCapture from "../../checkpointing/TurnCheckpointCapture.ts";
import * as CheckpointRevertRecovery from "../../checkpointing/CheckpointRevertRecovery.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { RuntimeReceiptBusTest } from "./RuntimeReceiptBus.ts";
import * as RuntimeReceiptBus from "../Services/RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  checkpointRefForRevertSafety,
  checkpointRefForThreadTurn,
} from "../../checkpointing/Utils.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ServerConfig } from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
    () => Effect.void,
  );
  const assertConversationRollbackSupported = vi.fn<
    ProviderServiceShape["assertConversationRollbackSupported"]
  >(() => Effect.void);
  const prepareConversationRollback = vi.fn<ProviderServiceShape["prepareConversationRollback"]>(
    ({ threadId, cwd: workspaceCwd, numTurns }) =>
      Effect.gen(function* () {
        yield* assertConversationRollbackSupported(threadId);
        if (!hasSession) {
          return yield* new ProviderValidationError({
            operation: "ProviderService.prepareConversationRollback",
            issue: "No provider session is bound to this thread.",
          });
        }
        return {
          source: {
            threadId,
            provider: providerName,
            providerInstanceId: ProviderInstanceId.make(providerName),
            cwd: workspaceCwd,
            runtimeMode: "full-access",
            resumeCursor: { threadId: "original-native-thread" },
          },
          numTurns,
          target: { lastTurnId: "retained-native-turn" },
        } as const;
      }),
  );
  const forkConversation = vi.fn<ProviderServiceShape["forkConversation"]>(() =>
    Effect.succeed({ threadId: "forked-native-thread" }),
  );
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    compactThread: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession,
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    assertConversationRollbackSupported,
    prepareConversationRollback,
    forkConversation,
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    uploadFeedback: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    assertConversationRollbackSupported,
    prepareConversationRollback,
    forkConversation,
    stopSession,
    rollbackConversation,
    emit,
  };
}

async function waitForThread(
  readModel: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly latestTurn: { readonly turnId: string } | null;
      readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
      readonly activities: ReadonlyArray<{ readonly kind: string }>;
    }>;
  }>,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | TurnCheckpointCapture.TurnCheckpointCapture
    | CheckpointStore.CheckpointStore
    | TurnCheckpointCapture.TurnCheckpointCapture
    | ProjectionSnapshotQuery
    | RuntimeReceiptBus.RuntimeReceiptBus
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly seedCheckpointSummaries?: boolean;
    readonly initializeGit?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly threadBranch?: string | null;
    readonly secondThreadSharingWorktree?: boolean;
    readonly localStatusRefName?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly pullRequestRefreshCalls?: Array<string>;
    readonly pullRequestRefresh?: Effect.Effect<void>;
  }) {
    const cwd = createGitRepository();
    if (options?.initializeGit === false) {
      NodeFS.rmSync(NodePath.join(cwd, ".git"), { recursive: true });
    }
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-checkpoint-reactor-test-",
    });
    const pullRequestRefreshes: number[] = [];
    const refreshAfterTurn = Effect.sync(() => void pullRequestRefreshes.push(1));
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef:
              options?.localStatusRefName === undefined || options.localStatusRefName === "main",
            refName:
              options?.localStatusRefName !== undefined ? options.localStatusRefName : "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      refreshPullRequestStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.pullRequestRefreshCalls?.push(cwd);
        }).pipe(Effect.andThen(options?.pullRequestRefresh ?? Effect.void), Effect.as(null)),
      streamStatus: () => Stream.empty,
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(TurnCheckpointCapture.layer),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusTest),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(Layer.mock(PullRequestService)({ refreshAfterTurn })),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const testRuntime = ManagedRuntime.make(layer);
    runtime = testRuntime;
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    let reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const checkpointReverts = await testRuntime.runPromise(
      CheckpointRevertRecovery.CheckpointRevertRecovery,
    );
    const captures = await runtime.runPromise(
      Effect.service(TurnCheckpointCapture.TurnCheckpointCapture),
    );
    const checkpointStore = await runtime.runPromise(
      Effect.service(CheckpointStore.CheckpointStore),
    );
    const receiptBus = await runtime.runPromise(
      Effect.service(RuntimeReceiptBus.RuntimeReceiptBus),
    );
    const testScope = await Effect.runPromise(Scope.make("sequential"));
    scope = testScope;
    const receipts = await Effect.runPromise(
      Effect.gen(function* () {
        const receipts = yield* Queue.unbounded<RuntimeReceiptBus.OrchestrationRuntimeReceipt>();
        yield* Stream.runForEach(receiptBus.streamEventsForTest, (receipt) =>
          Queue.offer(receipts, receipt),
        ).pipe(Effect.forkIn(testScope, { startImmediately: true }));
        yield* reactor.start().pipe(Scope.provide(testScope));
        return receipts;
      }),
    );
    const drain = () => Effect.runPromise(reactor.drain);
    const restartReactor = async () => {
      if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
      const nextScope = await Effect.runPromise(Scope.make("sequential"));
      scope = nextScope;
      reactor = await testRuntime.runPromise(
        Effect.gen(function* () {
          const services = yield* Layer.build(CheckpointReactorLive);
          const nextReactor = Context.get(services, CheckpointReactor);
          yield* nextReactor.start();
          return nextReactor;
        }).pipe(Scope.provide(nextScope)),
      );
    };

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: options?.threadBranch ?? null,
          worktreePath: options?.threadWorktreePath ?? cwd,
          createdAt,
        })
        .pipe(
          options?.secondThreadSharingWorktree
            ? Effect.andThen(
                engine.dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("cmd-thread-create-2"),
                  threadId: ThreadId.make("thread-2"),
                  projectId: asProjectId("project-1"),
                  title: "Thread 2",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5-codex",
                  },
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  runtimeMode: "approval-required",
                  branch: null,
                  worktreePath: options?.threadWorktreePath ?? cwd,
                  createdAt,
                }),
              )
            : Effect.asVoid,
        ),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    if (options?.seedCheckpointSummaries) {
      for (const turnCount of [1, 2]) {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-seed-checkpoint-${turnCount}`),
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId(`turn-${turnCount}`),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), turnCount),
            status: "ready",
            files: [],
            checkpointTurnCount: turnCount,
            createdAt,
          }),
        );
      }
    }

    const revertAndWait = (turnCount: number, commandId: CommandId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* engine.subscribeDomainEvents;
          yield* engine.dispatch({
            type: "thread.checkpoint.revert",
            commandId,
            threadId: ThreadId.make("thread-1"),
            turnCount,
            createdAt,
          });
          const outcome = yield* events.pipe(
            Stream.filter(
              (event) =>
                event.type === "thread.reverted" ||
                (event.type === "thread.activity-appended" &&
                  (event.payload.activity.kind === "checkpoint.revert.failed" ||
                    event.payload.activity.kind === "checkpoint.revert.recovery-required")),
            ),
            Stream.runHead,
          );
          yield* reactor.drain;
          return Option.getOrThrow(outcome);
        }),
      );

    return {
      engine,
      captures,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      provider,
      cwd,
      drain,
      restartReactor,
      sql,
      checkpointReverts,
      revertAndWait,
      nextReceipt: Queue.take(receipts),
      pullRequestRefreshes,
    };
  }

  effectIt.effect("captures late native edits after an earlier synthetic failure", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      const threadId = ThreadId.make("thread-1");
      const turnId = TurnId.make("late-native-turn");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const submission = yield* harness.captures.trackSubmission(threadId, providerInstanceId);
      yield* submission.beforeSubmit(turnId);
      const started = {
        type: "turn.started" as const,
        eventId: EventId.make("late-native-started"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        threadId,
        turnId,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      };
      yield* harness.captures.observe(started);
      harness.provider.emit(started);
      expect(yield* harness.nextReceipt).toMatchObject({ type: "checkpoint.baseline.captured" });
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "incomplete native work\n");
      const synthetic = {
        ...started,
        type: "turn.completed" as const,
        eventId: EventId.make("late-native-synthetic-failure"),
        payload: { state: "failed" as const },
      };
      yield* harness.captures.observe(synthetic);
      harness.provider.emit(synthetic);
      yield* harness.captures.awaitCapture(threadId);
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "finished native work\n");
      yield* submission.nativeCompleted(turnId);
      const confirmed = {
        ...synthetic,
        eventId: EventId.make("late-native-confirmed"),
        payload: { state: "completed" as const },
      };
      yield* harness.captures.observe(confirmed);
      harness.provider.emit(confirmed);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId,
      });
      yield* harness.captures.awaitNativeCapture(threadId);
      expect(
        gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
      ).toBe("finished native work\n");
    }),
  );

  effectIt.effect.each([null, TurnId.make("stale-primary-turn")])(
    "captures a confirmed native stop without a started event and active turn %s",
    (activeTurnId) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ seedFilesystemCheckpoints: false }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = TurnId.make("accepted-before-started");
        const providerInstanceId = ProviderInstanceId.make("codex");
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("accepted-no-start-session"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "approval-required",
            activeTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        const submission = yield* harness.captures.trackSubmission(threadId, providerInstanceId);
        yield* submission.beforeSubmit(turnId);
        yield* submission.accept(turnId);
        NodeFS.writeFileSync(
          NodePath.join(harness.cwd, "README.md"),
          "native edits before confirmed stop\n",
        );
        yield* submission.nativeStopped;
        const stopped = {
          type: "turn.aborted" as const,
          eventId: EventId.make("accepted-no-start-stopped"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          threadId,
          turnId,
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: { reason: "Native process exited." },
        };
        yield* harness.captures.observe(stopped);
        harness.provider.emit(stopped);
        yield* harness.captures.awaitNativeCapture(threadId);
        expect(
          gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
        ).toBe("native edits before confirmed stop\n");
      }),
  );

  effectIt.effect("captures baseline and large turn summaries before completion receipts", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-1"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
        checkpointTurnCount: 0,
      });

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
      const largeFileLineCount = 25_000;
      NodeFS.writeFileSync(
        NodePath.join(harness.cwd, "large.txt"),
        `${"payload".repeat(64)}\n`.repeat(largeFileLineCount),
        "utf8",
      );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-1"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: { state: "completed" },
      });

      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId: "turn-1",
        checkpointTurnCount: 1,
      });
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === "thread-1",
      );
      expect(thread?.checkpoints[0]).toMatchObject({
        checkpointTurnCount: 1,
        files: [
          { path: "large.txt", kind: "modified", additions: largeFileLineCount, deletions: 0 },
          { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
        ],
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "turn.processing.quiesced",
        turnId: "turn-1",
        checkpointTurnCount: 1,
      });
      yield* Effect.promise(harness.drain);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
      ).toBe(true);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
      ).toBe(true);
      expect(
        gitShowFileAtRef(
          harness.cwd,
          checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
          "README.md",
        ),
      ).toBe("v1\n");
      expect(
        gitShowFileAtRef(
          harness.cwd,
          checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
          "README.md",
        ),
      ).toBe("v2\n");
    }),
  );

  effectIt.effect("captures and reverts checkpoints from a nested Git workspace", () =>
    Effect.gen(function* () {
      const repositoryRoot = createGitRepository();
      tempDirs.push(repositoryRoot);
      const workspaceRoot = NodePath.join(repositoryRoot, "apps", "server");
      NodeFS.mkdirSync(workspaceRoot, { recursive: true });
      const filePath = NodePath.join(workspaceRoot, "index.ts");
      NodeFS.writeFileSync(filePath, "export const value = 1;\n");
      runGit(repositoryRoot, ["add", "."]);
      runGit(repositoryRoot, ["commit", "-m", "Add nested workspace"]);
      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          projectWorkspaceRoot: workspaceRoot,
          threadWorktreePath: workspaceRoot,
          providerSessionCwd: workspaceRoot,
        }),
      );
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-nested");
      const createdAt = "2026-01-01T00:00:00.000Z";
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-nested-start"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
      });
      yield* Effect.promise(harness.drain);
      expect(gitRefExists(repositoryRoot, checkpointRefForThreadTurn(threadId, 0))).toBe(true);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
      });

      NodeFS.writeFileSync(filePath, "export const value = 2;\n");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-nested-complete"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: { state: "completed" },
      });
      yield* Effect.promise(harness.drain);
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.checkpoints[0]).toMatchObject({
        status: "ready",
        files: [{ path: "apps/server/index.ts", additions: 1, deletions: 1 }],
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-nested-revert"),
        threadId,
        turnCount: 0,
        createdAt,
      });
      yield* Effect.promise(harness.drain);
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
        plan: expect.objectContaining({
          source: expect.objectContaining({ threadId }),
          numTurns: 1,
        }),
        resumeCursor: { threadId: "forked-native-thread" },
      });
      expect(gitRefExists(repositoryRoot, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
      const reverted = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(reverted?.checkpoints).toEqual([]);
    }),
  );

  effectIt.effect.each(["turn.completed", "turn.aborted"] as const)(
    "captures every edit after a mid-turn diff update on %s",
    (terminalEventType) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ seedFilesystemCheckpoints: false }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = asTurnId("turn-1");
        const assistantMessageId = MessageId.make("assistant:mid-turn");
        const createdAt = "2026-01-01T00:00:00.000Z";
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-mid-turn-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-mid-turn-start"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.baseline.captured",
        });

        NodeFS.writeFileSync(NodePath.join(harness.cwd, "early.ts"), "export const early = 1;\n");
        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-mid-turn-diff"),
          threadId,
          turnId,
          completedAt: createdAt,
          checkpointRef: CheckpointRef.make("provider-diff:mid-turn"),
          assistantMessageId,
          status: "missing",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        });
        yield* Effect.promise(harness.drain);

        NodeFS.writeFileSync(NodePath.join(harness.cwd, "late.ts"), "export const late = 2;\n");
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-mid-turn-settled"),
          threadId,
          session: {
            threadId,
            status: terminalEventType === "turn.aborted" ? "interrupted" : "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        harness.provider.emit({
          eventId: EventId.make("evt-mid-turn-complete"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId,
          ...(terminalEventType === "turn.completed"
            ? { type: "turn.completed", payload: { state: "completed" } }
            : { type: "turn.aborted", payload: { reason: "Interrupted by user." } }),
        });
        yield* Effect.promise(harness.drain);
        expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId,
          checkpointTurnCount: 1,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "turn.processing.quiesced",
          turnId,
        });
        yield* Effect.promise(harness.drain);
        const thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(thread?.checkpoints).toHaveLength(1);
        expect(thread?.checkpoints[0]?.status).toBe("ready");
        expect(thread?.latestTurn?.state).toBe(
          terminalEventType === "turn.aborted" ? "interrupted" : "completed",
        );
        expect(thread?.checkpoints[0]?.assistantMessageId).toBe(assistantMessageId);
        expect(thread?.checkpoints[0]?.files.map((file) => file.path)).toEqual([
          "early.ts",
          "late.ts",
        ]);
        expect(
          gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "late.ts"),
        ).toBe("export const late = 2;\n");

        const followUpTurnId = asTurnId("turn-2");
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-follow-up-start"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: followUpTurnId,
        });
        harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("evt-follow-up-complete"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: followUpTurnId,
          payload: { state: "completed" },
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: followUpTurnId,
          checkpointTurnCount: 2,
        });
        const followUp = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(
          followUp?.checkpoints.find((checkpoint) => checkpoint.turnId === followUpTurnId),
        ).toMatchObject({ checkpointTurnCount: 2, files: [] });
      }),
  );

  it("does not capture an aborted turn without a matching start or active session", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    harness.provider.emit({
      type: "turn.aborted",
      eventId: EventId.make("evt-untracked-abort"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-untracked"),
      payload: { reason: "Interrupted before the turn started." },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    expect(thread?.checkpoints).toEqual([]);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(false);
  });

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("re-asks for the pull request at turn end when the thread branch is checked out", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/feature",
      localStatusRefName: "t3code/feature",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-pr"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-pr"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
  });

  effectIt.effect("captures files while the pull request lookup is still pending", () =>
    Effect.gen(function* () {
      const lookupStarted = yield* Deferred.make<void>();
      const finishLookup = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          threadBranch: "t3code/feature",
          localStatusRefName: "t3code/feature",
          pullRequestRefresh: Deferred.succeed(lookupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishLookup)),
          ),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "completed turn\n");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-slow-pr"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-slow-pr"),
        payload: { state: "completed" },
      });

      yield* Deferred.await(lookupStarted);
      yield* Effect.gen(function* () {
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: "turn-slow-pr",
        });
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
            "README.md",
          ),
        ).toBe("completed turn\n");
      }).pipe(Effect.ensuring(Deferred.succeed(finishLookup, undefined)));
      yield* Effect.promise(harness.drain);
    }),
  );

  it("re-asks for the pull request after adopting a drifted checkout", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-drift-pr"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-drift-pr"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
  });

  it("does not re-ask for the pull request at turn end on the default branch", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "main",
      localStatusRefName: "main",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-no-pr-refresh"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-no-pr-refresh"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([]);
  });

  it("adopts a drifted checkout as the thread branch on a dedicated worktree", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.meta-updated" &&
        (event as unknown as { payload: { branch?: string } }).payload.branch ===
          "t3code/renamed-by-agent",
    );

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/renamed-by-agent");
  });

  it("does not adopt a drifted checkout when the worktree is shared by another thread", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
      secondThreadSharingWorktree: true,
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-shared"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-shared"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
    expect(pullRequestRefreshCalls).toEqual([]);
  });

  it("does not adopt a temporary placeholder checkout as the thread branch", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/0a1b2c3d",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-temp"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-temp"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/feature",
      localStatusRefName: "t3code/feature",
      pullRequestRefreshCalls,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
    });
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);
    expect(pullRequestRefreshCalls).toEqual([]);
    expect(harness.pullRequestRefreshes).toEqual([]);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    await harness.drain();
    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
    expect(harness.pullRequestRefreshes).toEqual([1]);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  effectIt.effect("captures a checkpoint without a summary when the baseline is missing", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-missing-baseline"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-missing-baseline"),
        payload: { state: "completed" },
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 1,
      });
      yield* Effect.promise(harness.drain);
      const thread = (yield* Effect.promise(harness.readModel)).threads[0];
      expect(thread?.checkpoints[0]).toMatchObject({
        status: "ready",
        checkpointTurnCount: 1,
        files: [],
      });
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
      ).toBe(true);
      expect(
        thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(false);
    }),
  );

  effectIt.effect.each([
    { timing: "between turns", commit: false },
    { timing: "between turns", commit: true },
    { timing: "during a turn", commit: false },
    { timing: "during a turn", commit: true },
  ])("resumes checkpointing after git init $timing (commit: $commit)", ({ timing, commit }) =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ initializeGit: false, seedFilesystemCheckpoints: false }),
      );
      const threadId = ThreadId.make("thread-1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const emit = (type: "turn.started" | "turn.completed", turn: number) =>
        harness.provider.emit({
          type,
          eventId: EventId.make(`${type}-${turn}`),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: asTurnId(`turn-${turn}`),
          ...(type === "turn.completed" ? { payload: { state: "completed" } } : {}),
        });
      emit("turn.started", 1);
      yield* Effect.promise(harness.drain);
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "before git\n");
      emit("turn.completed", 1);
      yield* Effect.promise(harness.drain);
      expect((yield* Effect.promise(harness.readModel)).threads[0]?.checkpoints).toEqual([]);

      if (timing === "during a turn") {
        emit("turn.started", 2);
        yield* Effect.promise(harness.drain);
      }
      runGit(harness.cwd, ["init", "--initial-branch=main"]);
      if (commit) {
        runGit(harness.cwd, ["add", "."]);
        runGit(harness.cwd, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "Initial",
        ]);
      }
      if (timing === "between turns") {
        // Exercise the domain entry point as well as the provider turn-start event.
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-after-git-init"),
          threadId,
          message: {
            messageId: MessageId.make("message-after-git-init"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.baseline.captured",
          checkpointTurnCount: 0,
        });
        emit("turn.started", 2);
        yield* Effect.promise(harness.drain);
      }
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "after git\n");
      emit("turn.completed", 2);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 1,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });
      yield* Effect.promise(harness.drain);
      const firstCheckpoint = (yield* Effect.promise(harness.readModel)).threads[0]?.checkpoints[0];
      expect(firstCheckpoint?.files).toEqual(
        timing === "between turns"
          ? [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }]
          : [],
      );
      expect(
        gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
      ).toBe("after git\n");
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0))).toBe(
        timing === "between turns",
      );

      emit("turn.started", 3);
      yield* Effect.promise(harness.drain);
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "next turn\n");
      emit("turn.completed", 3);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 2,
      });
      yield* Effect.promise(harness.drain);
      const thread = (yield* Effect.promise(harness.readModel)).threads[0];
      expect(thread?.checkpoints[1]?.files).toEqual([
        { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
      ]);
      expect(
        thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(false);
    }),
  );

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("does not create checkpoints while importing historical user messages", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    if (runtime === null) throw new Error("Checkpoint test runtime was not initialized.");

    await runtime.runPromise(
      harness.engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.make("cmd-import-history-without-checkpoint"),
        threadId: ThreadId.make("thread-1"),
        messages: [
          {
            messageId: MessageId.make("imported-user-message"),
            role: "user",
            text: "A message from an existing agent session",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await harness.drain();

    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(false);
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.make("evt-checkpoint-captured-3"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
  });

  effectIt.effect.each(["antigravity", "opencode"])(
    "rejects unsupported %s rewind before changing files, checkpoints, or history",
    (providerName) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ providerName: ProviderDriverKind.make(providerName) }),
        );
        const threadId = ThreadId.make("thread-1");
        const createdAt = "2026-01-01T00:00:00.000Z";
        const checked = yield* Deferred.make<void>();
        harness.provider.assertConversationRollbackSupported.mockImplementation(() =>
          Deferred.succeed(checked, undefined).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderValidationError({
                  operation: "ProviderService.assertConversationRollbackSupported",
                  issue: `Provider '${providerName}' does not support conversation rewind.`,
                }),
              ),
            ),
          ),
        );

        for (const turnCount of [1, 2]) {
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-unsupported-rewind-message-${turnCount}`),
            threadId,
            message: {
              messageId: MessageId.make(`message-unsupported-rewind-${turnCount}`),
              role: "user",
              text: `Keep message ${turnCount}`,
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          });
          yield* harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-unsupported-rewind-diff-${turnCount}`),
            threadId,
            turnId: asTurnId(`turn-unsupported-rewind-${turnCount}`),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
            status: "ready",
            files: [],
            checkpointTurnCount: turnCount,
            createdAt,
          });
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-unsupported-rewind-ready-${turnCount}`),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: ProviderDriverKind.make(providerName),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            operationResult: {
              requestId: MessageId.make(`message-unsupported-rewind-${turnCount}`),
              outcome: "completed",
            },
            createdAt,
          });
        }
        const before = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (thread) => thread.id === threadId,
        );

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-unsupported-rewind"),
          threadId,
          turnCount: 1,
          createdAt,
        });
        yield* Deferred.await(checked);
        yield* Effect.promise(() => harness.drain());

        const after = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (thread) => thread.id === threadId,
        );
        expect(after?.checkpoints).toEqual(before?.checkpoints);
        expect(after?.messages).toEqual(before?.messages);
        expect(after?.latestTurn).toEqual(before?.latestTurn);
        expect(after?.activities).toContainEqual(
          expect.objectContaining({
            kind: "checkpoint.revert.failed",
            payload: expect.objectContaining({
              detail: expect.stringContaining("does not support conversation rewind"),
            }),
          }),
        );
        expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
        expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
        expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
      }),
  );

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    await harness.drain();
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      plan: expect.objectContaining({
        source: expect.objectContaining({ threadId: ThreadId.make("thread-1") }),
        numTurns: 1,
      }),
      resumeCursor: { threadId: "forked-native-thread" },
    });
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness({ seedCheckpointSummaries: true });
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "unsaved changes\n");
    await Effect.runPromise(
      harness.revertAndWait(2, CommandId.make("cmd-sequenced-revert-request-2")),
    );
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    await Effect.runPromise(
      harness.revertAndWait(1, CommandId.make("cmd-sequenced-revert-request-1")),
    );
    await Effect.runPromise(
      harness.revertAndWait(0, CommandId.make("cmd-sequenced-revert-request-0")),
    );
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(3);
    expect(
      harness.provider.rollbackConversation.mock.calls.map(([input]) => input.plan.numTurns),
    ).toEqual([0, 1, 1]);
    expect(
      harness.provider.prepareConversationRollback.mock.calls.map(([input]) => input.targetTurnId),
    ).toEqual(["turn-2", "turn-1", null]);
  });

  effectIt.effect.each([
    { failedStage: "files-restored", savedStage: "restoring-files", adoptionCalls: 0 },
    { failedStage: "provider-started", savedStage: "files-restored", adoptionCalls: 0 },
    { failedStage: "provider-complete", savedStage: "provider-started", adoptionCalls: 1 },
  ])(
    "resumes after failing to save $failedStage without replacing the saved fork or safety ref",
    ({ failedStage, savedStage, adoptionCalls }) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ seedCheckpointSummaries: true }),
        );
        const threadId = ThreadId.make("thread-1");
        yield* harness.sql`
        CREATE TRIGGER reject_restored_files BEFORE UPDATE OF attempt_json ON checkpoint_revert_attempts
        WHEN json_extract(NEW.attempt_json, '$.stage') = ${harness.sql.literal(`'${failedStage}'`)}
        BEGIN SELECT RAISE(ABORT, 'injected failure after file restore'); END
      `;

        const failed = yield* harness.revertAndWait(1, CommandId.make("cmd-restore-failure"));
        expect(failed).toMatchObject({
          type: "thread.activity-appended",
          payload: { activity: { kind: "checkpoint.revert.recovery-required" } },
        });
        const pending = Option.getOrThrow(yield* harness.checkpointReverts.get(threadId));
        const safetyRef = checkpointRefForRevertSafety(threadId, pending.attemptId);
        expect(pending.stage).toBe(savedStage);
        expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
        expect(gitShowFileAtRef(harness.cwd, safetyRef, "README.md")).toBe("v3\n");
        expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
        expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(adoptionCalls);

        yield* harness.sql`DROP TRIGGER reject_restored_files`;
        yield* Effect.promise(harness.restartReactor);
        const recovered = yield* harness.revertAndWait(1, CommandId.make("cmd-restore-retry"));

        expect(recovered.type).toBe("thread.reverted");
        expect(harness.provider.prepareConversationRollback).toHaveBeenCalledTimes(1);
        expect(harness.provider.forkConversation).toHaveBeenCalledTimes(1);
        expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(adoptionCalls + 1);
        expect(Option.isNone(yield* harness.checkpointReverts.get(threadId))).toBe(true);
        expect(gitRefExists(harness.cwd, safetyRef)).toBe(false);
        expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(false);
      }),
  );

  effectIt.effect("retains refs and retries only the saved commit after provider adoption", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness({ seedCheckpointSummaries: true }));
      const threadId = ThreadId.make("thread-1");
      yield* harness.sql`
        CREATE TRIGGER reject_revert_commit BEFORE UPDATE OF attempt_json ON checkpoint_revert_attempts
        WHEN json_extract(NEW.attempt_json, '$.stage') = 'committed'
        BEGIN SELECT RAISE(ABORT, 'injected failure after provider adoption'); END
      `;

      yield* harness.revertAndWait(1, CommandId.make("cmd-commit-failure"));
      const pending = Option.getOrThrow(yield* harness.checkpointReverts.get(threadId));
      const safetyRef = checkpointRefForRevertSafety(threadId, pending.attemptId);
      expect(pending.stage).toBe("provider-complete");
      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
      expect(gitShowFileAtRef(harness.cwd, safetyRef, "README.md")).toBe("v3\n");
      const beforeRetry = yield* Effect.promise(harness.readModel);
      expect(
        beforeRetry.threads.find((thread) => thread.id === threadId)?.checkpoints,
      ).toHaveLength(2);

      yield* harness.sql`DROP TRIGGER reject_revert_commit`;
      yield* Effect.promise(harness.restartReactor);
      const recovered = yield* harness.revertAndWait(1, CommandId.make("cmd-commit-retry"));

      expect(recovered.type).toBe("thread.reverted");
      expect(harness.provider.forkConversation).toHaveBeenCalledTimes(1);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
      const completedEvents = yield* harness.engine.readEvents(0).pipe(
        Stream.filter((event) => event.type === "thread.reverted"),
        Stream.runCollect,
      );
      expect(completedEvents).toHaveLength(1);
      expect(Option.isNone(yield* harness.checkpointReverts.get(threadId))).toBe(true);
      expect(gitRefExists(harness.cwd, safetyRef)).toBe(false);
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(false);
    }),
  );

  effectIt.effect("rejects a missing baseline instead of restoring mutable HEAD", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness({ seedCheckpointSummaries: true }));
      const threadId = ThreadId.make("thread-1");
      runGit(harness.cwd, ["update-ref", "-d", checkpointRefForThreadTurn(threadId, 0)]);
      const result = yield* harness.revertAndWait(0, CommandId.make("cmd-missing-baseline"));
      expect(result).toMatchObject({
        type: "thread.activity-appended",
        payload: { activity: { kind: "checkpoint.revert.failed" } },
      });
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
      expect(harness.provider.prepareConversationRollback).not.toHaveBeenCalled();
      expect(harness.provider.stopSession).not.toHaveBeenCalled();
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
      expect(Option.isNone(yield* harness.checkpointReverts.get(threadId))).toBe(true);
    }),
  );

  effectIt.effect(
    "releases a failed unbound fork without changing files or the old conversation",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ seedCheckpointSummaries: true }),
        );
        const threadId = ThreadId.make("thread-1");
        harness.provider.forkConversation.mockImplementationOnce(() =>
          Effect.fail(
            new ProviderValidationError({
              operation: "ProviderService.forkConversation",
              issue: "The native fork did not contain the requested prefix.",
            }),
          ),
        );

        const failed = yield* harness.revertAndWait(1, CommandId.make("cmd-fork-failure"));
        expect(failed).toMatchObject({
          type: "thread.activity-appended",
          payload: { activity: { kind: "checkpoint.revert.failed" } },
        });
        expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
        expect(harness.provider.stopSession).not.toHaveBeenCalled();
        expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
        expect(Option.isNone(yield* harness.checkpointReverts.get(threadId))).toBe(true);

        const retried = yield* harness.revertAndWait(1, CommandId.make("cmd-fork-retry"));
        expect(retried.type).toBe("thread.reverted");
        expect(harness.provider.forkConversation).toHaveBeenCalledTimes(2);
        expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
      }),
  );

  effectIt.effect("reserves the rewind before a second client can send a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ seedCheckpointSummaries: true }),
        );
        const threadId = ThreadId.make("thread-1");
        const forkStarted = yield* Deferred.make<void>();
        const finishFork = yield* Deferred.make<void>();
        harness.provider.forkConversation.mockImplementationOnce(() =>
          Deferred.succeed(forkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishFork)),
            Effect.as({ threadId: "forked-native-thread" }),
          ),
        );
        const events = yield* harness.engine.subscribeDomainEvents;
        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-reserved-revert"),
          threadId,
          turnCount: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* Deferred.await(forkStarted);
        const rejected = yield* harness.engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-send-during-revert"),
            threadId,
            message: {
              messageId: MessageId.make("message-during-revert"),
              role: "user",
              text: "Do not send this while rewind is pending",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-01-01T00:00:01.000Z",
          })
          .pipe(Effect.flip);
        expect(rejected.message).toContain("revert to turn 1 is unfinished");
        expect((yield* Effect.promise(harness.readModel)).threads[0]?.messages).toHaveLength(0);

        yield* Deferred.succeed(finishFork, undefined);
        yield* events.pipe(
          Stream.filter((event) => event.type === "thread.reverted"),
          Stream.runHead,
        );
        yield* Effect.promise(harness.drain);
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-send-after-revert"),
          threadId,
          message: {
            messageId: MessageId.make("message-after-revert"),
            role: "user",
            text: "Continue after rewind",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        expect((yield* Effect.promise(harness.readModel)).threads[0]?.messages).toHaveLength(1);
      }),
    ),
  );

  it("appends an error activity when revert is requested without a provider binding", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-no-session"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
