import {
  ApprovalRequestId,
  EventId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { legacyStaleRequestFailureDetails } from "@t3tools/shared/requestActivity";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("counts pending questions from the retained lifecycle without event ordering", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-question-count");
      const createdAt = "2026-09-01T00:00:00.000Z";
      const upsert = (activityId: string, kind: string, payload: unknown) =>
        activities.upsert({
          activityId: EventId.make(activityId),
          threadId,
          turnId: null,
          tone: "info",
          kind,
          summary: "Question activity",
          payload,
          createdAt,
        });

      assert.strictEqual(yield* activities.countPendingUserInputsByThreadId({ threadId }), 0);

      yield* upsert("question-resolved-first", "user-input.resolved", { requestId: "closed" });
      yield* upsert("question-requested-later", "user-input.requested", { requestId: "closed" });
      yield* upsert("question-duplicate", "user-input.requested", { requestId: "closed" });
      yield* upsert("question-failed-after-resolution", "provider.user-input.respond.failed", {
        requestId: "closed",
        reason: "provider-error",
      });
      yield* upsert("question-active", "user-input.requested", { requestId: "17" });
      yield* upsert("question-active-duplicate", "user-input.requested", { requestId: "17" });
      yield* upsert("question-active-failure", "provider.user-input.respond.failed", {
        requestId: "17",
        reason: "provider-error",
      });
      yield* upsert("question-number-resolution", "user-input.resolved", { requestId: 17 });
      yield* upsert("question-number-request", "user-input.requested", { requestId: 18 });
      yield* upsert("question-object-request", "user-input.requested", { requestId: { id: "19" } });
      yield* upsert("question-no-request", "provider.user-input.respond.failed", {
        requestId: "never-requested",
        reason: "provider-error",
      });
      yield* activities.upsert({
        activityId: EventId.make("question-other-thread-resolution"),
        threadId: ThreadId.make("thread-question-count-other"),
        turnId: null,
        tone: "info",
        kind: "user-input.resolved",
        summary: "Other thread question resolved",
        payload: { requestId: "17" },
        sequence: 10,
        createdAt,
      });
      assert.strictEqual(yield* activities.countPendingUserInputsByThreadId({ threadId }), 1);

      yield* upsert("question-active-resolution", "user-input.resolved", { requestId: "17" });
      assert.strictEqual(yield* activities.countPendingUserInputsByThreadId({ threadId }), 0);

      // A replacement can remove the terminal fact from retained activity.
      yield* upsert("question-active-resolution", "user-input.resolved", { requestId: "closed" });
      assert.strictEqual(yield* activities.countPendingUserInputsByThreadId({ threadId }), 1);

      yield* activities.deleteByThreadId({ threadId });
      assert.strictEqual(yield* activities.countPendingUserInputsByThreadId({ threadId }), 0);
      yield* upsert("question-recreated", "user-input.requested", { requestId: "closed" });
      assert.strictEqual(yield* activities.countPendingUserInputsByThreadId({ threadId }), 1);
    }),
  );

  it.effect("uses typed stale outcomes before legacy question failure text", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const createdAt = "2026-09-01T00:00:00.000Z";
      const staleDetail = "Unknown pending user-input request";
      const cases = [
        { payload: { reason: "request-not-found" }, pending: 0 },
        { payload: { reason: "provider-error", detail: staleDetail }, pending: 1 },
        { payload: { reason: null, detail: staleDetail }, pending: 1 },
        { payload: { reason: "future-reason", detail: staleDetail }, pending: 1 },
        { payload: { reason: 1, detail: staleDetail }, pending: 1 },
        { payload: { detail: [staleDetail] }, pending: 1 },
        { payload: { detail: { message: staleDetail } }, pending: 1 },
        ...legacyStaleRequestFailureDetails["provider.user-input.respond.failed"].map((detail) => ({
          payload: { detail: detail.toUpperCase() },
          pending: 0,
        })),
      ];

      for (const [index, testCase] of cases.entries()) {
        const threadId = ThreadId.make(`thread-question-reason-${index}`);
        const requestId = `request-question-reason-${index}`;
        yield* activities.upsert({
          activityId: EventId.make(`question-reason-requested-${index}`),
          threadId,
          turnId: null,
          tone: "info",
          kind: "user-input.requested",
          summary: "Question requested",
          payload: { requestId },
          sequence: 100,
          createdAt: "2026-09-02T00:00:00.000Z",
        });
        yield* activities.upsert({
          activityId: EventId.make(`question-reason-failed-${index}`),
          threadId,
          turnId: null,
          tone: "error",
          kind: "provider.user-input.respond.failed",
          summary: "Question reply failed",
          payload: { requestId, ...testCase.payload },
          createdAt,
        });
        assert.strictEqual(
          yield* activities.countPendingUserInputsByThreadId({ threadId }),
          testCase.pending,
          `Failure case ${index}`,
        );
      }
    }),
  );

  it.effect("reads only one approval lifecycle from its thread", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-approval-lifecycle");
      const requestId = ApprovalRequestId.make("approval-lifecycle");
      const createdAt = "2026-09-01T00:00:00.000Z";

      for (const kind of [
        "approval.requested",
        "approval.resolved",
        "provider.approval.respond.failed",
      ]) {
        yield* activities.upsert({
          activityId: EventId.make(`lifecycle-${kind}`),
          threadId,
          turnId: null,
          tone: "info",
          kind,
          summary: "Approval activity",
          payload: { requestId },
          createdAt,
        });
      }

      // These rows must be excluded before full activity decoding.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES
          ('lifecycle-tool', ${threadId}, NULL, 'info', 'tool.completed', '', '{not-json', ${createdAt}),
          ('lifecycle-other-request', ${threadId}, NULL, 'invalid-tone', 'approval.requested', '',
            json_object('requestId', 'other-request'), ${createdAt}),
          ('lifecycle-question', ${threadId}, NULL, 'invalid-tone', 'user-input.requested', '',
            json_object('requestId', ${requestId}), ${createdAt}),
          ('lifecycle-other-thread', 'thread-approval-lifecycle-other', NULL, 'invalid-tone',
            'approval.requested', '', json_object('requestId', ${requestId}), ${createdAt})
      `;

      const rows = yield* activities.listApprovalLifecycleByRequestId({ threadId, requestId });
      assert.deepEqual(rows.map((row) => row.activityId).toSorted(), [
        "lifecycle-approval.requested",
        "lifecycle-approval.resolved",
        "lifecycle-provider.approval.respond.failed",
      ]);
      assert.deepEqual(
        yield* activities.listApprovalLifecycleByRequestId({
          threadId,
          requestId: ApprovalRequestId.make("missing-approval"),
        }),
        [],
      );
    }),
  );

  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        defaultThreadEnvMode: null,
        autoPull: false,
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("round-trips non-null settlement values through the thread row", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-settled"),
        projectId: ProjectId.make("project-1"),
        title: "Settled thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
        archivedAt: null,
        settledOverride: "settled",
        settledAt: "2026-03-25T00:00:00.000Z",
        unsettledAt: null,
        snoozedUntil: "2026-03-26T09:00:00.000Z",
        snoozedAt: "2026-03-25T00:00:00.000Z",
        pinnedAt: "2026-03-25T00:00:00.000Z",
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const row = Option.getOrNull(persisted);
      if (!row) {
        return yield* Effect.die("Expected settled projection_threads row to exist.");
      }
      assert.strictEqual(row.settledOverride, "settled");
      assert.strictEqual(row.settledAt, "2026-03-25T00:00:00.000Z");
      assert.strictEqual(row.snoozedUntil, "2026-03-26T09:00:00.000Z");
      assert.strictEqual(row.snoozedAt, "2026-03-25T00:00:00.000Z");
      assert.strictEqual(row.pinnedAt, "2026-03-25T00:00:00.000Z");

      // Un-settle to the keep-active pin and wake the snooze; confirm the
      // flips persist.
      yield* threads.upsert({
        ...row,
        settledOverride: "active",
        settledAt: null,
        unsettledAt: "2026-03-26T00:00:00.000Z",
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
      });
      const repersisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const updated = Option.getOrNull(repersisted);
      assert.strictEqual(updated?.settledOverride, "active");
      assert.strictEqual(updated?.settledAt, null);
      assert.strictEqual(updated?.unsettledAt, "2026-03-26T00:00:00.000Z");
      assert.strictEqual(updated?.snoozedUntil, null);
      assert.strictEqual(updated?.snoozedAt, null);
      assert.strictEqual(updated?.pinnedAt, null);
    }),
  );

  it.effect("round-trips a linked pull request through the thread row", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const linkedPullRequest = {
        projectId: ProjectId.make("project-linked-pr"),
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
      };

      yield* threads.upsert({
        threadId: ThreadId.make("thread-linked-pr"),
        projectId: ProjectId.make("project-linked-pr"),
        title: "Linked pull request",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        linkedPullRequest,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const persisted = yield* threads.getById({ threadId: ThreadId.make("thread-linked-pr") });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.linkedPullRequest, linkedPullRequest);

      const row = Option.getOrNull(persisted);
      if (row === null) return yield* Effect.die("Expected linked thread row to exist.");
      yield* threads.upsert({ ...row, linkedPullRequest: null });

      const cleared = yield* threads.getById({ threadId: ThreadId.make("thread-linked-pr") });
      assert.strictEqual(Option.getOrNull(cleared)?.linkedPullRequest, null);
    }),
  );
});
