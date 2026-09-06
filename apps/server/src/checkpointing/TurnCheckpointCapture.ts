import { type EventId, type ProviderRuntimeEvent, type ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type TerminalEvent = Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>;

export type CaptureOutcome = "captured" | "skipped" | "failed";

interface PendingCapture {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly events: Set<EventId>;
  readonly outcome: Deferred.Deferred<CaptureOutcome>;
}

interface ThreadCaptureState {
  activeTurnId: TurnId | undefined;
  readonly pending: Set<PendingCapture>;
}

export class TurnCheckpointCapture extends Context.Service<
  TurnCheckpointCapture,
  {
    readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    readonly expectInterrupt: (threadId: ThreadId) => Effect.Effect<Effect.Effect<void>>;
    readonly pendingCapture: (threadId: ThreadId) => Effect.Effect<Effect.Effect<void> | undefined>;
    readonly awaitCapture: (threadId: ThreadId) => Effect.Effect<void>;
    readonly complete: (event: TerminalEvent, outcome: CaptureOutcome) => Effect.Effect<void>;
  }
>()("t3/checkpointing/TurnCheckpointCapture") {}

// Tracks known terminal events before they reach the independent runtime consumers.
// An interrupt reserves the known active turn before adapter cancellation can return.
export const layer = Layer.effect(
  TurnCheckpointCapture,
  Effect.sync(() => {
    const threads = new Map<ThreadId, ThreadCaptureState>();
    const events = new Map<EventId, PendingCapture>();

    const stateFor = (threadId: ThreadId) => {
      let state = threads.get(threadId);
      if (!state) {
        state = { activeTurnId: undefined, pending: new Set() };
        threads.set(threadId, state);
      }
      return state;
    };

    const prepare = (threadId: ThreadId, turnId: TurnId | undefined) => {
      const state = stateFor(threadId);
      const existing = turnId
        ? [...state.pending].find((capture) => capture.turnId === turnId)
        : undefined;
      if (existing) return existing;
      const capture: PendingCapture = {
        threadId,
        turnId,
        events: new Set(),
        outcome: Deferred.makeUnsafe(),
      };
      state.pending.add(capture);
      return capture;
    };

    const complete = (capture: PendingCapture, outcome: CaptureOutcome) => {
      const state = threads.get(capture.threadId);
      state?.pending.delete(capture);
      if (state?.activeTurnId === undefined && state?.pending.size === 0) {
        threads.delete(capture.threadId);
      }
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

    return TurnCheckpointCapture.of({
      observe: (event) =>
        Effect.sync(() => {
          if (event.type === "turn.started" && event.turnId !== undefined) {
            stateFor(event.threadId).activeTurnId = TurnId.make(event.turnId);
          } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
            const state = stateFor(event.threadId);
            const turnId =
              event.turnId === undefined ? state.activeTurnId : TurnId.make(event.turnId);
            const capture = prepare(event.threadId, turnId);
            capture.events.add(event.eventId);
            events.set(event.eventId, capture);
            if (state.activeTurnId === turnId) state.activeTurnId = undefined;
          } else if (event.type === "session.exited") {
            const state = threads.get(event.threadId);
            if (!state) return;
            state.activeTurnId = undefined;
            for (const capture of state.pending) {
              // Terminal events can still be queued for capture after session exit.
              if (capture.events.size === 0) complete(capture, "skipped");
            }
            if (state.pending.size === 0) threads.delete(event.threadId);
          }
        }),
      expectInterrupt: (threadId) =>
        Effect.sync(() => {
          const turnId = threads.get(threadId)?.activeTurnId;
          if (turnId === undefined) return Effect.void;
          const capture = prepare(threadId, turnId);
          return Effect.sync(() => {
            // A failed interrupt can cancel its expectation, but not observed capture work.
            if (capture.events.size === 0) complete(capture, "skipped");
          });
        }),
      pendingCapture: (threadId) =>
        Effect.sync(() =>
          (threads.get(threadId)?.pending.size ?? 0) > 0 ? awaitCapture(threadId) : undefined,
        ),
      awaitCapture,
      complete: (event, outcome) =>
        Effect.sync(() => {
          const capture = events.get(event.eventId);
          if (capture) complete(capture, outcome);
        }),
    });
  }),
);
