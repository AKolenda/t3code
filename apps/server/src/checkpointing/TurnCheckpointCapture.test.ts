import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { layer, TurnCheckpointCapture } from "./TurnCheckpointCapture.ts";

const threadId = ThreadId.make("thread-1");
const started = {
  type: "turn.started" as const,
  eventId: EventId.make("started"),
  provider: ProviderDriverKind.make("codex"),
  threadId,
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: {},
};
const completed = {
  ...started,
  type: "turn.completed" as const,
  eventId: EventId.make("completed"),
  payload: { state: "completed" as const },
};

it.layer(layer)("TurnCheckpointCapture", (it) => {
  it.effect.each(["captured", "skipped", "failed"] as const)(
    "waits for a terminal capture and releases its %s outcome",
    (outcome) =>
      Effect.gen(function* () {
        const captures = yield* TurnCheckpointCapture;
        yield* captures.observe(completed);
        const waiting = yield* captures.awaitCapture(threadId).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.equal(waiting.pollUnsafe(), undefined);

        yield* captures.complete(completed, outcome);
        yield* Fiber.join(waiting);
        yield* captures.awaitCapture(threadId);
      }),
  );

  it.effect("reserves interruption before terminal delivery and keeps capture through exit", () =>
    Effect.gen(function* () {
      const captures = yield* TurnCheckpointCapture;
      yield* captures.observe(started);
      const cancelExpectation = yield* captures.expectInterrupt(threadId);
      const waiting = yield* captures.awaitCapture(threadId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(waiting.pollUnsafe(), undefined);

      yield* captures.observe(completed);
      yield* cancelExpectation;
      yield* captures.observe({
        ...started,
        type: "session.exited",
        eventId: EventId.make("exited"),
        payload: {},
      });
      yield* Effect.yieldNow;
      assert.equal(waiting.pollUnsafe(), undefined);

      yield* captures.complete(completed, "captured");
      yield* Fiber.join(waiting);
    }),
  );

  it.effect("cancels only an unobserved interrupt expectation", () =>
    Effect.gen(function* () {
      const captures = yield* TurnCheckpointCapture;
      yield* captures.observe(started);
      const cancelExpectation = yield* captures.expectInterrupt(threadId);
      yield* cancelExpectation;
      yield* captures.awaitCapture(threadId);

      yield* captures.observe(completed);
      const waiting = yield* captures.awaitCapture(threadId).pipe(Effect.forkChild);
      yield* cancelExpectation;
      yield* Effect.yieldNow;
      assert.equal(waiting.pollUnsafe(), undefined);
      yield* captures.complete(completed, "captured");
      yield* Fiber.join(waiting);
    }),
  );

  it.effect(
    "releases an interrupt expectation when its session exits without a terminal event",
    () =>
      Effect.gen(function* () {
        const captures = yield* TurnCheckpointCapture;
        yield* captures.observe(started);
        const cancelExpectation = yield* captures.expectInterrupt(threadId);
        const waiting = yield* captures.awaitCapture(threadId).pipe(Effect.forkChild);
        yield* captures.observe({
          ...started,
          type: "session.exited",
          eventId: EventId.make("exited-without-terminal"),
          payload: {},
        });
        yield* Fiber.join(waiting);
        yield* cancelExpectation;
        assert.equal(yield* captures.pendingCapture(threadId), undefined);
      }),
  );

  it.effect("does not release a newer turn's capture when an older turn finishes", () =>
    Effect.gen(function* () {
      const captures = yield* TurnCheckpointCapture;
      yield* captures.observe(completed);
      const newerTerminal = {
        ...completed,
        eventId: EventId.make("completed-newer"),
        turnId: TurnId.make("turn-2"),
      };
      yield* captures.observe(newerTerminal);
      const waiting = yield* captures.awaitCapture(threadId).pipe(Effect.forkChild);
      yield* captures.complete(completed, "captured");
      yield* Effect.yieldNow;
      assert.equal(waiting.pollUnsafe(), undefined);
      yield* captures.complete(newerTerminal, "captured");
      yield* Fiber.join(waiting);
    }),
  );

  it.effect("keeps the first interrupt reservation when a repeated interrupt fails", () =>
    Effect.gen(function* () {
      const captures = yield* TurnCheckpointCapture;
      yield* captures.observe(started);
      const cancelFirst = yield* captures.expectInterrupt(threadId);
      const cancelRetry = yield* captures.expectInterrupt(threadId);
      yield* cancelRetry;
      yield* cancelRetry;
      const waiting = yield* captures.awaitCapture(threadId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(waiting.pollUnsafe(), undefined);
      yield* captures.observe(completed);
      yield* captures.complete(completed, "captured");
      yield* Fiber.join(waiting);
      yield* cancelFirst;
    }),
  );

  it.effect("does not hold active-turn steering or another thread", () =>
    Effect.gen(function* () {
      const captures = yield* TurnCheckpointCapture;
      yield* captures.observe(started);
      yield* captures.awaitCapture(threadId);
      yield* captures.observe(completed);
      yield* captures.awaitCapture(ThreadId.make("other-thread"));
      yield* captures.complete(completed, "captured");
    }),
  );
});
