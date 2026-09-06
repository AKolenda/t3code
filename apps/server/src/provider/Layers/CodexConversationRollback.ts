import {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionStartInput,
  RuntimeMode,
  ThreadId,
  type TurnId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";

import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import { buildThreadStartParams, CodexResumeCursorSchema } from "./CodexSessionRuntime.ts";
import { codexLaunchArgv } from "./codexLaunchArgs.ts";

const PROVIDER = ProviderDriverKind.make("codex");
type RollbackClient = Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
const Goal = Schema.NullOr(CodexSchema.V2ThreadGoalGetResponse__ThreadGoal);
const sameGoal = Schema.toEquivalence(Goal);
const decodeCursor = Schema.decodeUnknownEffect(CodexResumeCursorSchema);
const decodeRead = Schema.decodeUnknownEffect(CodexSchema.V2ThreadReadResponse);
const decodeFork = Schema.decodeUnknownEffect(CodexSchema.V2ThreadForkResponse);
const decodeGoal = Schema.decodeUnknownEffect(Schema.Struct({ goal: Goal }));

export const CodexConversationRollbackTarget = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  sourceThreadId: TrimmedNonEmptyString,
  codexHome: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  modelSelection: Schema.optional(ModelSelection),
  retainedTurnIds: Schema.Array(TrimmedNonEmptyString),
  firstRemovedTurnId: Schema.NullOr(TrimmedNonEmptyString),
  goal: Goal,
});
type RollbackTarget = typeof CodexConversationRollbackTarget.Type;

/** Codex applies disable flags after enable flags, regardless of their argv order. */
export function codexConversationRollbackLaunchArgs(launchArgs?: string): ReadonlyArray<string> {
  const args = codexLaunchArgv(launchArgs);
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--disable=goals") continue;
    if (arg === "--disable" && args[index + 1] === "goals") {
      index += 1;
      continue;
    }
    if (arg !== undefined) result.push(arg);
  }
  return [...result, "--enable", "goals"];
}

const invalid = (issue: string) =>
  new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation: "conversationRollback",
    issue,
  });

const requestError = (method: string) => (cause: { readonly message: string }) =>
  new ProviderAdapterRequestError({ provider: PROVIDER, method, detail: cause.message, cause });

// 0.153.0 includes native before-turn forks and durable goal deferral.
// Older app servers can ignore unknown fields before we validate the result.
const requireSafeForkVersion = Effect.fn("CodexConversationRollback.requireSafeForkVersion")(
  function* (userAgent: string) {
    const version = userAgent.match(/\/([^\s]+)/)?.[1];
    if (!version || !parseSemver(version) || compareSemverVersions(version, "0.153.0") < 0) {
      return yield* invalid(
        "Safe conversation rewind requires Codex 0.153.0 or later. Update Codex and retry.",
      );
    }
  },
);

const readThread = Effect.fn("CodexConversationRollback.readThread")(function* (
  client: RollbackClient,
  threadId: string,
) {
  const response = yield* client
    .request("thread/read", { threadId, includeTurns: true })
    .pipe(Effect.flatMap(decodeRead), Effect.mapError(requestError("thread/read")));
  const thread = response.thread;
  if (thread.id !== threadId || thread.ephemeral || !thread.path) {
    return yield* invalid("Codex did not return the saved conversation's persistent history.");
  }
  if (
    thread.status.type === "active" ||
    thread.turns.some((turn) => turn.status === "inProgress")
  ) {
    return yield* invalid("Stop the Codex turn before rewinding its conversation.");
  }
  const turnIds = thread.turns.map((turn) => turn.id);
  if (new Set(turnIds).size !== turnIds.length) {
    return yield* invalid("Codex returned duplicate turn IDs. The rewind boundary is ambiguous.");
  }
  return turnIds;
});

const readGoal = Effect.fn("CodexConversationRollback.readGoal")(function* (
  client: RollbackClient,
  threadId: string,
) {
  const response = yield* client
    .request("thread/goal/get", { threadId })
    .pipe(Effect.flatMap(decodeGoal), Effect.mapError(requestError("thread/goal/get")));
  if (response.goal !== null && response.goal.threadId !== threadId) {
    return yield* invalid("Codex returned a goal for a different conversation.");
  }
  return response.goal;
});

/** Save native IDs before any files or provider bindings change. No session is resumed. */
export const prepareCodexConversationRollback = Effect.fn("prepareCodexConversationRollback")(
  function* (
    client: RollbackClient,
    input: ProviderSessionStartInput & { readonly targetTurnId: TurnId | null },
    initialize: { readonly codexHome: string; readonly userAgent: string },
  ) {
    yield* requireSafeForkVersion(initialize.userAgent);
    if (!input.cwd || !input.providerInstanceId) {
      return yield* invalid(
        "A saved workspace and provider instance are required to rewind Codex.",
      );
    }
    if (input.modelSelection && input.modelSelection.instanceId !== input.providerInstanceId) {
      return yield* invalid("The Codex model and conversation use different provider instances.");
    }
    const cursor = yield* decodeCursor(input.resumeCursor).pipe(
      Effect.mapError(() => invalid("A saved Codex conversation ID is required to rewind.")),
    );
    const turnIds = yield* readThread(client, cursor.threadId);
    // Failed checkpoints, imported history, and direct Codex input can make
    // native turn counts differ from T3 checkpoint counts. Only the ID is exact.
    const retainedTurnCount =
      input.targetTurnId === null ? 0 : turnIds.indexOf(input.targetTurnId) + 1;
    if (input.targetTurnId !== null && retainedTurnCount === 0) {
      return yield* invalid(
        "The checkpoint's turn is missing from the saved Codex conversation. Rewind stopped before changing files.",
      );
    }
    const goal = yield* readGoal(client, cursor.threadId);
    return {
      schemaVersion: 1,
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      sourceThreadId: cursor.threadId,
      codexHome: initialize.codexHome,
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      retainedTurnIds: turnIds.slice(0, retainedTurnCount),
      firstRemovedTurnId: turnIds[retainedTurnCount] ?? null,
      goal,
    } satisfies RollbackTarget;
  },
);

/** A lost reply can leave an unused fork, but retrying never truncates the source. */
export const forkCodexConversationRollback = Effect.fn("forkCodexConversationRollback")(function* (
  client: RollbackClient,
  target: RollbackTarget,
  userAgent: string,
) {
  yield* requireSafeForkVersion(userAgent);
  const turnIds = yield* readThread(client, target.sourceThreadId);
  if (
    target.retainedTurnIds.some((turnId, index) => turnIds[index] !== turnId) ||
    (turnIds[target.retainedTurnIds.length] ?? null) !== target.firstRemovedTurnId
  ) {
    return yield* invalid("The saved Codex rewind boundary no longer matches the source history.");
  }
  const sourceGoal = yield* readGoal(client, target.sourceThreadId);
  if (!sameGoal(sourceGoal, target.goal)) {
    return yield* invalid("The Codex goal changed after this rewind was prepared.");
  }

  const lastTurnId = target.retainedTurnIds.at(-1);
  // These experimental fields are absent from the generated schema. The native
  // fork persists an empty prefix and keeps its goal paused until the next turn.
  const params = {
    ...buildThreadStartParams({
      cwd: target.cwd,
      runtimeMode: target.runtimeMode,
      model: target.modelSelection?.model,
      serviceTier: target.modelSelection
        ? getCodexServiceTierOptionValue(target.modelSelection)
        : undefined,
    }),
    threadId: target.sourceThreadId,
    ...(lastTurnId
      ? { lastTurnId }
      : target.firstRemovedTurnId
        ? { beforeTurnId: target.firstRemovedTurnId }
        : {}),
    ephemeral: false,
    deferGoalContinuation: true,
    config: { "features.goals": true },
  } satisfies CodexSchema.V2ThreadForkParams & {
    readonly beforeTurnId?: string;
    readonly deferGoalContinuation: boolean;
  };
  const response = yield* client
    .request("thread/fork", params)
    .pipe(Effect.flatMap(decodeFork), Effect.mapError(requestError("thread/fork")));
  const fork = response.thread;
  if (
    fork.id === target.sourceThreadId ||
    fork.ephemeral ||
    !fork.path ||
    (fork.forkedFromId != null && fork.forkedFromId !== target.sourceThreadId) ||
    fork.status.type === "active" ||
    fork.turns.some((turn) => turn.status === "inProgress") ||
    fork.turns.length !== target.retainedTurnIds.length ||
    fork.turns.some((turn, index) => turn.id !== target.retainedTurnIds[index])
  ) {
    return yield* invalid(
      "Codex did not create the exact requested rewind. Update Codex and retry.",
    );
  }

  const forkGoal = yield* readGoal(client, fork.id);
  if (!sameGoal(target.goal === null ? null : { ...target.goal, threadId: fork.id }, forkGoal)) {
    return yield* invalid("Codex did not preserve the goal in the rewind. Update Codex and retry.");
  }
  return { threadId: fork.id };
});
