import {
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import { ConversationRollbackPlan } from "../provider/ConversationRollback.ts";

const RequestFields = {
  threadId: ThreadId,
  attemptId: EventId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
};

export const RequestedRevert = Schema.Struct({
  ...RequestFields,
  stage: Schema.Literal("requested"),
});

const TargetFields = {
  ...RequestFields,
  cwd: Schema.String,
  sourceTurnCount: NonNegativeInt,
  targetCheckpointRef: CheckpointRef,
  safetyCheckpointRef: CheckpointRef,
  staleCheckpointRefs: Schema.Array(CheckpointRef),
  completionCommandId: CommandId,
  rollbackPlan: ConversationRollbackPlan,
};

export const PlannedRevert = Schema.Struct({
  ...TargetFields,
  stage: Schema.Literal("preparing-provider"),
});

export const ForkedRevert = Schema.Struct({
  ...TargetFields,
  stage: Schema.Literals([
    "provider-prepared",
    "restoring-files",
    "files-restored",
    "provider-started",
    "provider-complete",
    "committed",
  ]),
  resumeCursor: Schema.NullOr(Schema.Unknown),
});
export type ForkedRevert = typeof ForkedRevert.Type;

export const PreparedRevert = Schema.Union([PlannedRevert, ForkedRevert]);
export type PreparedRevert = typeof PreparedRevert.Type;

export const RevertAttempt = Schema.Union([RequestedRevert, PreparedRevert]);
export type RevertAttempt = typeof RevertAttempt.Type;

export class CheckpointRevertRecoveryError extends Schema.TaggedErrorClass<CheckpointRevertRecoveryError>()(
  "CheckpointRevertRecoveryError",
  { threadId: ThreadId, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const toPersistenceError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

// This record is not a projection. It must survive a restart between Git,
// provider rollback, and the transaction that saves thread.reverted.
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ attempt: Schema.fromJsonString(RevertAttempt) }),
    execute: (threadId) => sql`
      SELECT attempt_json AS attempt
      FROM checkpoint_revert_attempts
      WHERE thread_id = ${threadId}
    `,
  });
  const get = Effect.fn("CheckpointRevertRecovery.get")(function* (threadId: ThreadId) {
    return yield* getRow(threadId).pipe(
      Effect.map(Option.map((row) => row.attempt)),
      Effect.mapError(toPersistenceError("CheckpointRevertRecovery.get")),
    );
  });

  const reserveRow = SqlSchema.void({
    Request: RequestedRevert,
    execute: (attempt) => sql`
      INSERT INTO checkpoint_revert_attempts (thread_id, attempt_id, attempt_json)
      VALUES (${attempt.threadId}, ${attempt.attemptId}, ${JSON.stringify(attempt)})
      ON CONFLICT (thread_id) DO NOTHING
    `,
  });
  const reserve = Effect.fn("CheckpointRevertRecovery.reserve")(function* (
    attempt: typeof RequestedRevert.Type,
  ) {
    yield* reserveRow(attempt).pipe(
      Effect.mapError(toPersistenceError("CheckpointRevertRecovery.reserve")),
    );
  });

  const saveRow = SqlSchema.findOneOption({
    Request: PreparedRevert,
    Result: Schema.Struct({ attemptId: EventId }),
    execute: (attempt) => sql`
      UPDATE checkpoint_revert_attempts
      SET attempt_json = ${JSON.stringify(attempt)}
      WHERE thread_id = ${attempt.threadId} AND attempt_id = ${attempt.attemptId}
      RETURNING attempt_id AS "attemptId"
    `,
  });
  const save = Effect.fn("CheckpointRevertRecovery.save")(function* (attempt: PreparedRevert) {
    const saved = yield* saveRow(attempt).pipe(
      Effect.mapError(toPersistenceError("CheckpointRevertRecovery.save")),
    );
    if (Option.isNone(saved)) {
      return yield* new CheckpointRevertRecoveryError({
        threadId: attempt.threadId,
        detail: "The checkpoint revert recovery record changed before its next step was saved.",
      });
    }
  });

  const clear = Effect.fn("CheckpointRevertRecovery.clear")(function* (
    attempt: Pick<RevertAttempt, "threadId" | "attemptId">,
  ) {
    yield* sql`
      DELETE FROM checkpoint_revert_attempts
      WHERE thread_id = ${attempt.threadId} AND attempt_id = ${attempt.attemptId}
    `.pipe(Effect.mapError(toPersistenceError("CheckpointRevertRecovery.clear")));
  });

  return { get, reserve, save, clear };
});
