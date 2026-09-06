import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, TurnId } from "./baseSchemas.ts";
import { SourceProposedPlanReference } from "./orchestration.ts";
import type {
  OrchestrationEvent,
  OrchestrationOperationResult,
  OrchestrationPendingOperation,
  OrchestrationThread,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
} from "./orchestration.ts";

type CommandMessage = {
  readonly role: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
};

/** Classifies slash-command input before it becomes a typed operation. */
export function isContextCompactionMessage(message: CommandMessage): boolean {
  return (
    message.role === "user" &&
    (message.attachments?.length ?? 0) === 0 &&
    message.text.trim().toLowerCase() === "/compact"
  );
}

const decodeLegacyRequest = Schema.decodeUnknownOption(Schema.Struct({ requestId: MessageId }));

export const OrchestrationTurnStartAcceptance = Schema.Struct({
  requestId: MessageId,
  turnId: TurnId,
  requestedAt: IsoDateTime,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationTurnStartAcceptance = typeof OrchestrationTurnStartAcceptance.Type;
const decodeTurnStartAcceptance = Schema.decodeUnknownOption(OrchestrationTurnStartAcceptance);

/** Reads the request binding returned by sendTurn, not a provider lifecycle guess. */
export function turnStartAcceptance(activity: OrchestrationThreadActivity) {
  return activity.kind === "provider.turn.start.accepted"
    ? Option.getOrNull(decodeTurnStartAcceptance(activity.payload))
    : null;
}

/** Keeps original turn metadata when steering reuses an already accepted turn. */
export function bindAcceptedTurn(
  turn: OrchestrationLatestTurn | null,
  accepted: OrchestrationTurnStartAcceptance | null,
): OrchestrationLatestTurn | null {
  if (!turn || !accepted || turn.turnId !== accepted.turnId || turn.requestId !== undefined) {
    return turn;
  }
  return {
    ...turn,
    requestId: accepted.requestId,
    requestedAt: accepted.requestedAt,
    ...(accepted.sourceProposedPlan ? { sourceProposedPlan: accepted.sourceProposedPlan } : {}),
  };
}

/** Acceptance can precede turn.started, so replay retains it in the hidden activity. */
export function bindTurnFromActivities(
  turn: OrchestrationLatestTurn | null,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationLatestTurn | null {
  if (!turn || turn.requestId !== undefined) return turn;
  for (const activity of activities) {
    if (activity.turnId !== turn.turnId) continue;
    const accepted = turnStartAcceptance(activity);
    if (accepted) return bindAcceptedTurn(turn, accepted);
  }
  return turn;
}

/** Identifies a request only after its accepted provider turn is visible. */
export function acceptedRequestIdForEvent(
  thread: Pick<OrchestrationThread, "latestTurn" | "activities">,
  event: OrchestrationEvent,
): MessageId | undefined {
  if (event.type === "thread.activity-appended") {
    const accepted = turnStartAcceptance(event.payload.activity);
    return accepted && thread.latestTurn?.turnId === accepted.turnId
      ? accepted.requestId
      : undefined;
  }
  if (event.type !== "thread.session-set" || event.payload.session.status !== "running")
    return undefined;
  const turnId = event.payload.session.activeTurnId;
  if (thread.latestTurn?.turnId === turnId && thread.latestTurn.requestId !== undefined)
    return thread.latestTurn.requestId;
  for (const activity of thread.activities) {
    if (activity.turnId !== turnId) continue;
    const accepted = turnStartAcceptance(activity);
    if (accepted) return accepted.requestId;
  }
  return undefined;
}

function operationResultForEvent(
  pending: OrchestrationPendingOperation,
  event: OrchestrationEvent,
): OrchestrationOperationResult | null {
  if (event.type !== "thread.session-set" && event.type !== "thread.activity-appended") {
    return null;
  }
  if (event.payload.operationResult !== undefined) {
    return event.payload.operationResult;
  }

  // Old event logs and older remote servers do not carry typed results.
  // New producers emit null when an event does not resolve an operation.
  if (event.type === "thread.session-set") {
    return event.payload.session.status === "ready" &&
      event.commandId?.startsWith("server:provider-session-set:") === true
      ? { requestId: pending.requestId, outcome: "completed" }
      : null;
  }
  const activity = event.payload.activity;
  if (activity.kind !== "context-compaction" && activity.kind !== "provider.turn.start.failed") {
    return null;
  }
  const request = decodeLegacyRequest(activity.payload);
  return Option.isSome(request)
    ? {
        requestId: request.value.requestId,
        outcome: activity.kind === "context-compaction" ? "completed" : "failed",
      }
    : null;
}

/** Projects the pending request independently of provider turn IDs. */
export function pendingOperationAfterEvent(
  pending: OrchestrationPendingOperation | null,
  event: OrchestrationEvent,
  legacyMessage?: CommandMessage,
  acceptedRequestId?: MessageId,
): OrchestrationPendingOperation | null {
  switch (event.type) {
    case "thread.created":
    case "thread.reverted":
      return null;
    case "thread.turn-start-requested":
      return pending?.kind === "compact"
        ? pending
        : {
            kind:
              event.payload.operation ??
              (legacyMessage !== undefined && isContextCompactionMessage(legacyMessage)
                ? "compact"
                : "turn"),
            requestId: event.payload.messageId,
          };
    case "thread.session-set":
    case "thread.activity-appended": {
      if (pending === null) return null;
      const result = operationResultForEvent(pending, event);
      if (result !== null) {
        if (
          event.type === "thread.activity-appended" &&
          turnStartAcceptance(event.payload.activity) &&
          acceptedRequestId !== result.requestId
        )
          return pending;
        return result.requestId === pending.requestId ? null : pending;
      }
      if (event.type === "thread.session-set") {
        const session = event.payload.session;
        // A stopped session ends all requests. Other modern lifecycle updates
        // can belong to an older turn and cannot identify the pending request.
        if (session.status === "stopped") return null;
        if (session.status === "running" && acceptedRequestId === pending.requestId) return null;
        if (event.payload.operationResult !== undefined) return pending;
        if (
          session.status === "error" ||
          session.status === "interrupted" ||
          (pending.kind === "turn" && session.status === "running" && session.activeTurnId !== null)
        ) {
          return null;
        }
      }
      return pending;
    }
    default:
      return pending;
  }
}

type OperationThread = Pick<OrchestrationThread, "pendingOperation" | "latestTurn" | "session"> &
  Partial<Pick<OrchestrationThread, "messages" | "activities">>;

/** Reads current operation state, with a fallback for snapshots from older servers. */
export function getThreadPendingOperation(
  thread: OperationThread | null | undefined,
): OrchestrationPendingOperation | null {
  if (!thread) return null;
  if (thread.pendingOperation !== undefined) return thread.pendingOperation;
  if (thread.session?.status !== "starting" && thread.session?.status !== "running") {
    return null;
  }
  const message = thread.messages?.findLast(isContextCompactionMessage);
  if (
    !message ||
    !(
      message.createdAt > (thread.latestTurn?.requestedAt ?? message.createdAt) ||
      (thread.latestTurn?.state === "running" &&
        message.createdAt === thread.latestTurn.requestedAt)
    )
  ) {
    return null;
  }
  const settled = thread.activities?.some((activity) => {
    if (activity.kind !== "context-compaction" && activity.kind !== "provider.turn.start.failed") {
      return false;
    }
    const request = decodeLegacyRequest(activity.payload);
    return Option.isSome(request) && request.value.requestId === message.id;
  });
  return settled ? null : { kind: "compact", requestId: message.id };
}
