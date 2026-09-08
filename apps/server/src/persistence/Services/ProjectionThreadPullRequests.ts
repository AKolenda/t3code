import {
  IsoDateTime,
  PositiveInt,
  ThreadId,
  ThreadPullRequestKey,
  ThreadPullRequestLinkSource,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPullRequest = Schema.Struct({
  threadId: ThreadId,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadPullRequestSnapshot),
  stack: Schema.NullOr(ThreadPullRequestStack),
});
export type ProjectionThreadPullRequest = typeof ProjectionThreadPullRequest.Type;

export const ListProjectionThreadPullRequestsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadPullRequestsInput =
  typeof ListProjectionThreadPullRequestsInput.Type;

export const ListProjectionThreadPullRequestsByPullRequestInput = ThreadPullRequestKey;
export type ListProjectionThreadPullRequestsByPullRequestInput =
  typeof ListProjectionThreadPullRequestsByPullRequestInput.Type;

export const DeleteProjectionThreadPullRequestInput = Schema.Struct({
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
});
export type DeleteProjectionThreadPullRequestInput =
  typeof DeleteProjectionThreadPullRequestInput.Type;

export const DeleteProjectionThreadPullRequestsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadPullRequestsInput =
  typeof DeleteProjectionThreadPullRequestsInput.Type;

export const DeleteProjectionThreadPullRequestsBySourceInput = Schema.Struct({
  threadId: ThreadId,
  source: ThreadPullRequestLinkSource,
});
export type DeleteProjectionThreadPullRequestsBySourceInput =
  typeof DeleteProjectionThreadPullRequestsBySourceInput.Type;

export interface ProjectionThreadPullRequestRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadPullRequest,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadPullRequestsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequest>, ProjectionRepositoryError>;
  readonly listByPullRequest: (
    input: ListProjectionThreadPullRequestsByPullRequestInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequest>, ProjectionRepositoryError>;
  readonly delete: (
    input: DeleteProjectionThreadPullRequestInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadPullRequestsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadIdAndSource: (
    input: DeleteProjectionThreadPullRequestsBySourceInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadPullRequestRepository extends Context.Service<
  ProjectionThreadPullRequestRepository,
  ProjectionThreadPullRequestRepositoryShape
>()("t3/persistence/Services/ProjectionThreadPullRequests/ProjectionThreadPullRequestRepository") {}
