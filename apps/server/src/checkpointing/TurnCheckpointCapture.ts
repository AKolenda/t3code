import {
  type EventId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type TerminalEvent = Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>;

export type CaptureOutcome = "captured" | "skipped" | "failed";

interface PendingCapture {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly turnId: TurnId | undefined;
  readonly events: Set<EventId>;
  readonly reservations: Set<symbol>;
  readonly outcome: Deferred.Deferred<CaptureOutcome>;
}

interface ThreadCaptureState {
  activeTurnId: TurnId | undefined;
  activeInstanceId: ProviderInstanceId | undefined;
  readonly pending: Set<PendingCapture>;
  readonly submissions: Set<NativeSubmission>;
}

export type TurnSubmissionOutcome =
  | { readonly _tag: "NotSubmitted" }
  | { readonly _tag: "Accepted"; readonly turnId: TurnId }
  | { readonly _tag: "UnknownSubmission"; readonly turnId: TurnId | undefined };

interface NativeSubmission {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  turnId: TurnId | undefined;
  nativeStopped: boolean;
  readonly nativeTerminals: Set<TurnId>;
  readonly capturedTurns: Set<TurnId>;
  readonly released: Deferred.Deferred<void>;
}

export interface TurnSubmission {
  readonly beforeSubmit: (turnId?: TurnId) => Effect.Effect<void>;
  readonly notSubmitted: Effect.Effect<void>;
  readonly nativeCompleted: (turnId: TurnId) => Effect.Effect<void>;
  readonly nativeStopped: Effect.Effect<void>;
  readonly accept: (turnId: TurnId) => Effect.Effect<void>;
  readonly outcome: Effect.Effect<TurnSubmissionOutcome>;
}

// An unresolved Codex request can receive native terminals before its response.
// Keep those receipts with that request, not in an unbounded thread history.
const MAX_EARLY_TERMINALS = 16;

const remember = (turns: Set<TurnId>, turnId: TurnId) => {
  turns.add(turnId);
  if (turns.size > MAX_EARLY_TERMINALS) {
    const oldest = turns.values().next().value;
    if (oldest !== undefined) turns.delete(oldest);
  }
};

export class TurnCheckpointCapture extends Context.Service<
  TurnCheckpointCapture,
  {
    readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    readonly expectInterrupt: (threadId: ThreadId) => Effect.Effect<Effect.Effect<void>>;
    readonly pendingCapture: (threadId: ThreadId) => Effect.Effect<Effect.Effect<void> | undefined>;
    readonly awaitCapture: (threadId: ThreadId) => Effect.Effect<void>;
    readonly complete: (event: TerminalEvent, outcome: CaptureOutcome) => Effect.Effect<void>;
    readonly trackSubmission: (
      threadId: ThreadId,
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<TurnSubmission>;
    readonly awaitNativeCapture: (threadId: ThreadId) => Effect.Effect<void>;
    readonly nativeCaptureReady: (event: TerminalEvent) => Effect.Effect<boolean | undefined>;
  }
>()("t3/checkpointing/TurnCheckpointCapture") {}

// Tracks known terminal events before they reach the independent runtime consumers.
// An interrupt reserves the known active turn before adapter cancellation can return.
export function make(): TurnCheckpointCapture["Service"] {
  const threads = new Map<ThreadId, ThreadCaptureState>();
  const events = new Map<EventId, PendingCapture>();
  const nativeCaptures = new Map<
    EventId,
    {
      readonly allowed: boolean;
      readonly turnId: TurnId | undefined;
      readonly submissions: ReadonlyArray<NativeSubmission>;
    }
  >();

  const stateFor = (threadId: ThreadId) => {
    let state = threads.get(threadId);
    if (!state) {
      state = {
        activeTurnId: undefined,
        activeInstanceId: undefined,
        pending: new Set(),
        submissions: new Set(),
      };
      threads.set(threadId, state);
    }
    return state;
  };

  const prepare = (
    threadId: ThreadId,
    turnId: TurnId | undefined,
    instanceId: ProviderInstanceId | undefined,
  ) => {
    const state = stateFor(threadId);
    const existing = turnId
      ? [...state.pending].find(
          (capture) => capture.turnId === turnId && capture.instanceId === instanceId,
        )
      : undefined;
    if (existing) return existing;
    const capture: PendingCapture = {
      threadId,
      instanceId,
      turnId,
      events: new Set(),
      reservations: new Set(),
      outcome: Deferred.makeUnsafe(),
    };
    state.pending.add(capture);
    return capture;
  };

  const forgetEmptyThread = (threadId: ThreadId) => {
    const state = threads.get(threadId);
    if (
      state?.activeTurnId === undefined &&
      state?.pending.size === 0 &&
      state.submissions.size === 0
    )
      threads.delete(threadId);
  };

  const releaseSubmission = (submission: NativeSubmission) => {
    threads.get(submission.threadId)?.submissions.delete(submission);
    Deferred.doneUnsafe(submission.released, Effect.void);
    forgetEmptyThread(submission.threadId);
  };

  const finishSubmission = (submission: NativeSubmission) => {
    const turnId = submission.turnId;
    if (
      (turnId === undefined && submission.nativeStopped) ||
      (turnId !== undefined &&
        (submission.nativeStopped || submission.nativeTerminals.has(turnId)) &&
        submission.capturedTurns.has(turnId))
    )
      releaseSubmission(submission);
  };

  const complete = (capture: PendingCapture, outcome: CaptureOutcome) => {
    const state = threads.get(capture.threadId);
    state?.pending.delete(capture);
    forgetEmptyThread(capture.threadId);
    for (const eventId of capture.events) events.delete(eventId);
    Deferred.doneUnsafe(capture.outcome, Effect.succeed(outcome));
  };

  const awaitCapture = Effect.fn("TurnCheckpointCapture.awaitCapture")(function* (
    threadId: ThreadId,
  ) {
    while (true) {
      const pending = [...(threads.get(threadId)?.pending ?? [])];
      if (pending.length === 0) return;
      yield* Effect.forEach(pending, (capture) => Deferred.await(capture.outcome), {
        discard: true,
      });
    }
  });

  const awaitNativeCapture = Effect.fn("TurnCheckpointCapture.awaitNativeCapture")(function* (
    threadId: ThreadId,
  ) {
    while (true) {
      yield* awaitCapture(threadId);
      const submissions = [...(threads.get(threadId)?.submissions ?? [])];
      if (submissions.length === 0) return;
      yield* Effect.forEach(submissions, (submission) => Deferred.await(submission.released), {
        discard: true,
      });
    }
  });

  return TurnCheckpointCapture.of({
    observe: (event) =>
      Effect.sync(() => {
        if (event.type === "turn.started" && event.turnId !== undefined) {
          stateFor(event.threadId).activeTurnId = TurnId.make(event.turnId);
          stateFor(event.threadId).activeInstanceId = event.providerInstanceId;
        } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
          const state = stateFor(event.threadId);
          const turnId =
            event.turnId === undefined ? state.activeTurnId : TurnId.make(event.turnId);
          const capture = prepare(event.threadId, turnId, event.providerInstanceId);
          const submissions = [...state.submissions].filter(
            (submission) =>
              submission.instanceId === event.providerInstanceId &&
              (submission.turnId === undefined || submission.turnId === turnId),
          );
          // A local failure can arrive while native work still runs. Its capture
          // cannot be reused when a later native terminal finally confirms completion.
          nativeCaptures.set(event.eventId, {
            allowed: submissions.every(
              (submission) =>
                submission.nativeStopped ||
                (turnId !== undefined && submission.nativeTerminals.has(turnId)),
            ),
            turnId,
            submissions,
          });
          capture.events.add(event.eventId);
          events.set(event.eventId, capture);
          if (
            state.activeTurnId === turnId &&
            state.activeInstanceId === event.providerInstanceId
          ) {
            state.activeTurnId = undefined;
          }
        } else if (event.type === "session.exited") {
          const state = threads.get(event.threadId);
          if (!state) return;
          if (state.activeInstanceId === event.providerInstanceId) state.activeTurnId = undefined;
          for (const capture of state.pending) {
            // Terminal events can still be queued for capture after session exit.
            if (capture.events.size === 0 && capture.instanceId === event.providerInstanceId) {
              complete(capture, "skipped");
            }
          }
          forgetEmptyThread(event.threadId);
        }
      }),
    expectInterrupt: (threadId) =>
      Effect.sync(() => {
        const turnId = threads.get(threadId)?.activeTurnId;
        if (turnId === undefined) return Effect.void;
        const capture = prepare(threadId, turnId, threads.get(threadId)?.activeInstanceId);
        const reservation = Symbol();
        capture.reservations.add(reservation);
        return Effect.sync(() => {
          capture.reservations.delete(reservation);
          // A failed call cannot release another interrupt or observed capture work.
          if (capture.reservations.size === 0 && capture.events.size === 0) {
            complete(capture, "skipped");
          }
        });
      }),
    pendingCapture: (threadId) =>
      Effect.sync(() =>
        (threads.get(threadId)?.pending.size ?? 0) > 0 ? awaitCapture(threadId) : undefined,
      ),
    awaitCapture,
    awaitNativeCapture,
    nativeCaptureReady: (event) =>
      Effect.sync(() => {
        const capture = nativeCaptures.get(event.eventId);
        return capture !== undefined && capture.submissions.length > 0
          ? capture.allowed
          : undefined;
      }),
    trackSubmission: (threadId, instanceId) =>
      Effect.sync(() => {
        let submission: NativeSubmission | undefined;
        let outcome: TurnSubmissionOutcome = { _tag: "NotSubmitted" };
        return {
          beforeSubmit: Effect.fn("TurnCheckpointCapture.beforeSubmit")(function* (
            turnId?: TurnId,
          ) {
            if (submission !== undefined) return;
            while (true) {
              yield* awaitCapture(threadId);
              const state = threads.get(threadId);
              if ((state?.pending.size ?? 0) > 0) continue;
              if (
                state?.activeTurnId !== undefined &&
                (state.activeTurnId !== turnId || state.activeInstanceId !== instanceId)
              ) {
                prepare(threadId, state.activeTurnId, state.activeInstanceId);
                continue;
              }
              const blockers = [...(threads.get(threadId)?.submissions ?? [])].filter(
                (active) =>
                  turnId === undefined ||
                  active.turnId !== turnId ||
                  active.instanceId !== instanceId,
              );
              if (blockers.length > 0) {
                yield* Effect.forEach(blockers, (active) => Deferred.await(active.released), {
                  discard: true,
                });
                continue;
              }
              // No yield between checking ownership and marking possible native submission.
              submission = {
                threadId,
                instanceId,
                turnId,
                nativeStopped: false,
                nativeTerminals: new Set(),
                capturedTurns: new Set(),
                released: Deferred.makeUnsafe(),
              };
              stateFor(threadId).submissions.add(submission);
              outcome = { _tag: "UnknownSubmission", turnId };
              return;
            }
          }),
          notSubmitted: Effect.sync(() => {
            if (submission !== undefined) releaseSubmission(submission);
            submission = undefined;
            outcome = { _tag: "NotSubmitted" };
          }),
          nativeCompleted: (turnId) =>
            Effect.sync(() => {
              if (submission === undefined) return;
              remember(submission.nativeTerminals, turnId);
              finishSubmission(submission);
            }),
          nativeStopped: Effect.sync(() => {
            if (submission === undefined) return;
            submission.nativeStopped = true;
            finishSubmission(submission);
          }),
          accept: (turnId) =>
            Effect.sync(() => {
              if (submission !== undefined) {
                submission.turnId = turnId;
                finishSubmission(submission);
              }
              outcome = { _tag: "Accepted", turnId };
            }),
          outcome: Effect.sync(() => outcome),
        } satisfies TurnSubmission;
      }),
    complete: (event, outcome) =>
      Effect.sync(() => {
        const capture = events.get(event.eventId);
        if (capture) complete(capture, outcome);
        const nativeCapture = nativeCaptures.get(event.eventId);
        nativeCaptures.delete(event.eventId);
        if (nativeCapture?.allowed && nativeCapture.turnId !== undefined) {
          for (const submission of nativeCapture.submissions) {
            remember(submission.capturedTurns, nativeCapture.turnId);
            finishSubmission(submission);
          }
        }
      }),
  });
}

export const layer = Layer.effect(TurnCheckpointCapture, Effect.sync(make));
