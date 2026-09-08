import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function expectSingleEvent<Type extends OrchestrationEvent["type"]>(
  decided: PlannedEvent | ReadonlyArray<PlannedEvent>,
  type: Type,
): Omit<Extract<OrchestrationEvent, { type: Type }>, "sequence"> {
  const event = Array.isArray(decided) ? decided[0] : (decided as PlannedEvent);
  if (event === undefined || event.type !== type) {
    throw new Error(`expected ${type}, got ${String(event?.type)}`);
  }
  return event as Omit<Extract<OrchestrationEvent, { type: Type }>, "sequence">;
}

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeLink(overrides: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number: 42,
    url: "https://github.com/t3tools/t3code/pull/42",
    source: "manual",
    linkedAt: NOW,
    snapshot: null,
    stack: null,
    ...overrides,
  };
}

function makeReadModel(pullRequests: ReadonlyArray<ThreadPullRequestLink>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const snapshot: ThreadPullRequestSnapshot = {
  state: "open",
  title: "Add links",
  headBranch: "feat/links",
  baseBranch: "main",
  isDraft: false,
  updatedAt: NOW,
  syncedAt: NOW,
};

it.layer(NodeServices.layer)("pull request link decider", (it) => {
  it.effect("links a pull request with a normalized key and empty host state", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-link"),
          threadId: THREAD_ID,
          host: " GitHub.com ",
          repository: "T3Tools/T3Code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "manual",
        },
        readModel: makeReadModel([]),
      });
      expect(Array.isArray(decided)).toBe(false);
      const event = expectSingleEvent(decided, "thread.pull-request-linked");
      expect(event.payload.link).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
        url: "https://github.com/t3tools/t3code/pull/42",
        source: "manual",
        linkedAt: event.payload.updatedAt,
        snapshot: null,
        stack: null,
      });
      expect(event.payload.updatedAt).not.toBe(NOW);
    }),
  );

  it.effect("rejects linking a pull request that is already linked", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-link-dup"),
          threadId: THREAD_ID,
          host: "GITHUB.COM",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "agent",
        },
        readModel: makeReadModel([makeLink()]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("re-linking a dismissed stack member un-dismisses it", () =>
    Effect.gen(function* () {
      const dismissed = makeLink({
        source: "stack-dismissed",
        snapshot,
        stack: {
          kind: "native",
          id: "stack-1",
          number: 1,
          url: "https://github.com/t3tools/t3code/stack/1",
          base: "main",
          layers: [{ number: 42, headBranch: "feat/links", state: "open" }],
        },
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-relink"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "manual",
        },
        readModel: makeReadModel([dismissed]),
      });
      const event = expectSingleEvent(decided, "thread.pull-request-linked");
      // Host state survives the flip; only the source changes.
      expect(event.payload.link).toEqual({ ...dismissed, source: "manual" });
    }),
  );

  it.effect("rejects a stack sync re-adding a dismissed stack member", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-stack-readd"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "stack",
        },
        readModel: makeReadModel([makeLink({ source: "stack-dismissed" })]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("unlinks a manual pull request", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("cmd-unlink"),
          threadId: THREAD_ID,
          host: "GitHub.com",
          repository: "t3tools/t3code",
          number: 42,
        },
        readModel: makeReadModel([makeLink()]),
      });
      const event = expectSingleEvent(decided, "thread.pull-request-unlinked");
      expect(event.payload).toMatchObject({
        threadId: THREAD_ID,
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
      });
    }),
  );

  it.effect("unlinking a stack member leaves a stack-dismissed tombstone", () =>
    Effect.gen(function* () {
      const member = makeLink({ source: "stack", snapshot });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("cmd-unlink-stack"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
        },
        readModel: makeReadModel([member]),
      });
      const event = expectSingleEvent(decided, "thread.pull-request-linked");
      expect(event.payload.link).toEqual({ ...member, source: "stack-dismissed" });
    }),
  );

  it.effect("rejects unlinking a pull request that is not linked", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("cmd-unlink-missing"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 7,
        },
        readModel: makeReadModel([makeLink()]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects syncing a pull request that is not linked", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.sync",
          commandId: CommandId.make("cmd-sync-missing"),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          snapshot,
          stack: null,
        },
        readModel: makeReadModel([]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("sync emits the host snapshot for a linked pull request", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.sync",
          commandId: CommandId.make("cmd-sync"),
          threadId: THREAD_ID,
          host: "GitHub.com",
          repository: "t3tools/t3code",
          number: 42,
          snapshot,
          stack: null,
        },
        readModel: makeReadModel([makeLink()]),
      });
      const event = expectSingleEvent(decided, "thread.pull-request-synced");
      expect(event.payload).toMatchObject({
        threadId: THREAD_ID,
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
        snapshot,
        stack: null,
      });
    }),
  );
});
