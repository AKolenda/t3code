import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@t3tools/contracts";
import { legacyStaleRequestFailureDetails } from "@t3tools/shared/requestActivity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionApprovalLifecycleInput,
  ListProjectionThreadActivitiesInput,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

const mapActivityRows = (
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>>,
): ReadonlyArray<ProjectionThreadActivity> =>
  rows.map((row) => ({
    activityId: row.activityId,
    threadId: row.threadId,
    turnId: row.turnId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  }));

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadActivityRow = SqlSchema.void({
    Request: ProjectionThreadActivity,
    execute: (row) =>
      sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${JSON.stringify(row.payload)},
              ${row.sequence ?? null},
              ${row.createdAt}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              sequence = excluded.sequence,
              created_at = excluded.created_at
          `,
  });

  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listUserInputLifecycleActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND kind IN (
            'user-input.requested',
            'user-input.resolved',
            'provider.user-input.respond.failed'
          )
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const deleteProjectionThreadActivityRows = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `,
  });

  // A terminal event closes its request regardless of activity order. Group in
  // SQLite so shell refreshes do not decode retained question payloads.
  const countPendingUserInputRows = SqlSchema.findOne({
    Request: ListProjectionThreadActivitiesInput,
    Result: Schema.Struct({ count: NonNegativeInt }),
    execute: ({ threadId }) => sql`
      SELECT COUNT(*) AS count
      FROM (
        SELECT json_extract(payload_json, '$.requestId')
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND CASE
            WHEN kind IN (
              'user-input.requested',
              'user-input.resolved',
              'provider.user-input.respond.failed'
            ) THEN json_type(payload_json, '$.requestId') = 'text'
            ELSE 0
          END
        GROUP BY json_extract(payload_json, '$.requestId')
        HAVING MAX(kind = 'user-input.requested') = 1
          AND MAX(CASE
            WHEN kind = 'user-input.resolved' THEN 1
            WHEN kind = 'provider.user-input.respond.failed' AND (
              json_extract(payload_json, '$.reason') = 'request-not-found'
              OR (
                json_type(payload_json, '$.reason') IS NULL
                AND json_type(payload_json, '$.detail') = 'text'
                AND ${sql.or(
                  legacyStaleRequestFailureDetails["provider.user-input.respond.failed"].map(
                    (detail) =>
                      sql`instr(lower(json_extract(payload_json, '$.detail')), ${detail}) > 0`,
                  ),
                )}
              )
            ) THEN 1
            ELSE 0
          END) = 0
      )
    `,
  });

  const listApprovalLifecycleRows = SqlSchema.findAll({
    Request: ListProjectionApprovalLifecycleInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, requestId }) => sql`
      SELECT
        activity_id AS "activityId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payload",
        sequence,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND CASE
          WHEN kind IN (
            'approval.requested',
            'approval.resolved',
            'provider.approval.respond.failed'
          ) THEN json_type(payload_json, '$.requestId') = 'text'
            AND json_extract(payload_json, '$.requestId') = ${requestId}
          ELSE 0
        END
    `,
  });

  const upsert: ProjectionThreadActivityRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadActivityRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.upsert:query",
          "ProjectionThreadActivityRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadActivityRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.listByThreadId:query",
          "ProjectionThreadActivityRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map(mapActivityRows),
    );

  const listUserInputLifecycleByThreadId: ProjectionThreadActivityRepositoryShape["listUserInputLifecycleByThreadId"] =
    (input) =>
      listUserInputLifecycleActivityRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.listUserInputLifecycleByThreadId:query",
            "ProjectionThreadActivityRepository.listUserInputLifecycleByThreadId:decodeRows",
          ),
        ),
        Effect.map(mapActivityRows),
      );

  const deleteByThreadId: ProjectionThreadActivityRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByThreadId:query"),
      ),
    );

  const countPendingUserInputsByThreadId: ProjectionThreadActivityRepositoryShape["countPendingUserInputsByThreadId"] =
    (input) =>
      countPendingUserInputRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.countPendingUserInputsByThreadId:query",
            "ProjectionThreadActivityRepository.countPendingUserInputsByThreadId:decodeRows",
          ),
        ),
        Effect.map((row) => row.count),
      );

  const listApprovalLifecycleByRequestId: ProjectionThreadActivityRepositoryShape["listApprovalLifecycleByRequestId"] =
    (input) =>
      listApprovalLifecycleRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.listApprovalLifecycleByRequestId:query",
            "ProjectionThreadActivityRepository.listApprovalLifecycleByRequestId:decodeRows",
          ),
        ),
        Effect.map(mapActivityRows),
      );

  return {
    upsert,
    listByThreadId,
    listUserInputLifecycleByThreadId,
    countPendingUserInputsByThreadId,
    listApprovalLifecycleByRequestId,
    deleteByThreadId,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
