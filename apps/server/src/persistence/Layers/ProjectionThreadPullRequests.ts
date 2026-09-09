import * as ProjectionThreadPullRequests from "../Services/ProjectionThreadPullRequests.ts";
import { ThreadPullRequestSnapshot, ThreadPullRequestStack } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadPullRequestInput,
  DeleteProjectionThreadPullRequestsBySourceInput,
  DeleteProjectionThreadPullRequestsInput,
  ListProjectionThreadPullRequestsByPullRequestInput,
  ListProjectionThreadPullRequestsInput,
  ProjectionThreadPullRequest,
} from "../Services/ProjectionThreadPullRequests.ts";

const ProjectionThreadPullRequestDbRow = ProjectionThreadPullRequest.mapFields(
  Struct.assign({
    snapshot: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestSnapshot)),
    stack: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestStack)),
  }),
);

const makeProjectionThreadPullRequestRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadPullRequestRow = SqlSchema.void({
    Request: ProjectionThreadPullRequest,
    execute: (row) => sql`
      INSERT INTO projection_thread_pull_requests (
        thread_id,
        host,
        repository,
        number,
        url,
        source,
        linked_at,
        snapshot_json,
        stack_json
      )
      VALUES (
        ${row.threadId},
        ${row.host},
        ${row.repository},
        ${row.number},
        ${row.url},
        ${row.source},
        ${row.linkedAt},
        ${row.snapshot === null ? null : JSON.stringify(row.snapshot)},
        ${row.stack === null ? null : JSON.stringify(row.stack)}
      )
      ON CONFLICT (thread_id, host, repository, number)
      DO UPDATE SET
        url = excluded.url,
        source = excluded.source,
        linked_at = excluded.linked_at,
        snapshot_json = excluded.snapshot_json,
        stack_json = excluded.stack_json
    `,
  });

  const listProjectionThreadPullRequestRows = SqlSchema.findAll({
    Request: ListProjectionThreadPullRequestsInput,
    Result: ProjectionThreadPullRequestDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        host,
        repository,
        number,
        url,
        source,
        linked_at AS "linkedAt",
        snapshot_json AS "snapshot",
        stack_json AS "stack"
      FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
      ORDER BY linked_at ASC, number ASC
    `,
  });

  const listProjectionThreadPullRequestRowsByPullRequest = SqlSchema.findAll({
    Request: ListProjectionThreadPullRequestsByPullRequestInput,
    Result: ProjectionThreadPullRequestDbRow,
    execute: ({ host, repository, number }) => sql`
      SELECT
        thread_id AS "threadId",
        host,
        repository,
        number,
        url,
        source,
        linked_at AS "linkedAt",
        snapshot_json AS "snapshot",
        stack_json AS "stack"
      FROM projection_thread_pull_requests
      WHERE host = ${host}
        AND repository = ${repository}
        AND number = ${number}
      ORDER BY linked_at ASC, thread_id ASC
    `,
  });

  const deleteProjectionThreadPullRequestRow = SqlSchema.void({
    Request: DeleteProjectionThreadPullRequestInput,
    execute: ({ threadId, host, repository, number }) => sql`
      DELETE FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
        AND host = ${host}
        AND repository = ${repository}
        AND number = ${number}
    `,
  });

  const deleteProjectionThreadPullRequestRows = SqlSchema.void({
    Request: DeleteProjectionThreadPullRequestsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteProjectionThreadPullRequestRowsBySource = SqlSchema.void({
    Request: DeleteProjectionThreadPullRequestsBySourceInput,
    execute: ({ threadId, source }) => sql`
      DELETE FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
        AND source = ${source}
    `,
  });

  const upsert: ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository["Service"]["upsert"] =
    (row) =>
      upsertProjectionThreadPullRequestRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPullRequestRepository.upsert:query"),
        ),
      );

  const listByThreadId: ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository["Service"]["listByThreadId"] =
    (input) =>
      listProjectionThreadPullRequestRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPullRequestRepository.listByThreadId:query"),
        ),
      );

  const listByPullRequest: ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository["Service"]["listByPullRequest"] =
    (input) =>
      listProjectionThreadPullRequestRowsByPullRequest(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPullRequestRepository.listByPullRequest:query"),
        ),
      );

  const deleteLink: ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository["Service"]["delete"] =
    (input) =>
      deleteProjectionThreadPullRequestRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPullRequestRepository.delete:query"),
        ),
      );

  const deleteByThreadId: ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository["Service"]["deleteByThreadId"] =
    (input) =>
      deleteProjectionThreadPullRequestRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPullRequestRepository.deleteByThreadId:query"),
        ),
      );

  const deleteByThreadIdAndSource: ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository["Service"]["deleteByThreadIdAndSource"] =
    (input) =>
      deleteProjectionThreadPullRequestRowsBySource(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadPullRequestRepository.deleteByThreadIdAndSource:query",
          ),
        ),
      );

  return {
    upsert,
    listByThreadId,
    listByPullRequest,
    delete: deleteLink,
    deleteByThreadId,
    deleteByThreadIdAndSource,
  } satisfies ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository["Service"];
});

export const ProjectionThreadPullRequestRepositoryLive = Layer.effect(
  ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository,
  makeProjectionThreadPullRequestRepository,
);
