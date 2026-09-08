import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  isAutoSettlementCandidate,
  shouldAutoSettleThread,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const candidates = snapshot.threads.filter((thread) => isAutoSettlementCandidate(thread, now));
    // Linked threads read their pull requests from the synced snapshots, so
    // only unlinked threads share a saved-branch lookup.
    const lookupKey = (thread: (typeof candidates)[number]) => {
      if (visibleThreadPullRequests(thread.pullRequests).length > 0) {
        return JSON.stringify(["linked", thread.id]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const project = projects.get(thread.projectId);
      return JSON.stringify(
        project === undefined
          ? ["missing-project", thread.id]
          : ["branch", project.workspaceRoot, thread.branch],
      );
    };
    const groups = Map.groupBy(candidates, lookupKey);

    const pullRequestsFor = Effect.fn("ThreadSettlementReactor.pullRequestsFor")(function* (
      thread: (typeof candidates)[number],
    ) {
      const links = visibleThreadPullRequests(thread.pullRequests);
      if (links.length > 0) {
        // A link the sync reactor has not snapshotted yet counts as open: the
        // thread stays active until the host has said otherwise.
        return links.map(
          (link): SettlementPullRequest =>
            link.snapshot === null
              ? { state: "open", updatedAt: null }
              : { state: link.snapshot.state, updatedAt: link.snapshot.updatedAt },
        );
      }
      if (thread.branch === null) return [] as ReadonlyArray<SettlementPullRequest>;
      const project = projects.get(thread.projectId);
      if (project === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      const pullRequest = yield* git.branchPullRequest({
        cwd: project.workspaceRoot,
        branch: thread.branch,
      });
      return pullRequest === null ? [] : [pullRequest satisfies SettlementPullRequest];
    });

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const pullRequests = yield* pullRequestsFor(group[0]!);
          yield* Effect.forEach(
            group,
            (thread) =>
              Effect.gen(function* () {
                const settings = yield* settingsService.getSettings;
                const decisionNow = DateTime.formatIso(yield* DateTime.now);
                if (
                  !shouldAutoSettleThread({
                    thread,
                    pullRequests,
                    now: decisionNow,
                    autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
                    autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
                  })
                ) {
                  return;
                }
                const uuid = yield* crypto.randomUUIDv4;
                yield* engine.dispatch({
                  type: "thread.auto-settle",
                  commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  snapshotSequence: snapshot.snapshotSequence,
                });
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("automatic thread settlement skipped", {
                        threadId: thread.id,
                        cause: Cause.pretty(cause),
                      }),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastAfterDays = initialSettings.sidebarAutoSettleAfterDays;
    let lastOnMerge = initialSettings.sidebarAutoSettleOnMerge;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        if (
          settings.sidebarAutoSettleAfterDays === lastAfterDays &&
          settings.sidebarAutoSettleOnMerge === lastOnMerge
        ) {
          return Effect.void;
        }
        lastAfterDays = settings.sidebarAutoSettleAfterDays;
        lastOnMerge = settings.sidebarAutoSettleOnMerge;
        return worker.enqueue(undefined);
      }),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementReactor["Service"];
});

export const layer = Layer.effect(ThreadSettlementReactor, make);
