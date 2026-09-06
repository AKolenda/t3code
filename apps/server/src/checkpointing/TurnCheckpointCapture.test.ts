import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { layer, make, TurnCheckpointCapture } from "./TurnCheckpointCapture.ts";

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

const instanceId = ProviderInstanceId.make("codex");
const nativeTerminal = { ...completed, providerInstanceId: instanceId };

it.effect.each(["captured", "skipped", "failed"] as const)(
  "waits for native completion and its exact %s capture outcome",
  (outcome) =>
    Effect.gen(function* () {
      const captures = make();
      const submission = yield* captures.trackSubmission(threadId, instanceId);
      yield* submission.beforeSubmit(nativeTerminal.turnId);
      const next = yield* captures.trackSubmission(threadId, instanceId);
      const waiting = yield* next.beforeSubmit(TurnId.make("next")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(waiting.pollUnsafe(), undefined);
      yield* submission.nativeCompleted(nativeTerminal.turnId);
      yield* captures.observe(nativeTerminal);
      assert.equal(yield* captures.shouldCapture(nativeTerminal), true);
      assert.equal(waiting.pollUnsafe(), undefined);
      yield* captures.complete(nativeTerminal, outcome);
      yield* Fiber.join(waiting);
      yield* next.notSubmitted;
    }),
);

it.effect("does not reuse a synthetic failure capture after native completion", () =>
  Effect.gen(function* () {
    const captures = make();
    const submission = yield* captures.trackSubmission(threadId, instanceId);
    yield* submission.beforeSubmit(nativeTerminal.turnId);
    yield* captures.observe(nativeTerminal);
    assert.equal(yield* captures.shouldCapture(nativeTerminal), false);
    yield* captures.complete(nativeTerminal, "skipped");
    yield* submission.nativeCompleted(nativeTerminal.turnId);
    const waiting = yield* captures.awaitNativeCapture(threadId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(waiting.pollUnsafe(), undefined);
    const confirmed = { ...nativeTerminal, eventId: EventId.make("confirmed") };
    yield* captures.observe(confirmed);
    assert.equal(yield* captures.shouldCapture(confirmed), true);
    yield* captures.complete(confirmed, "captured");
    yield* Fiber.join(waiting);
  }),
);

it.effect("does not release a fresh native capture through an older grouped event", () =>
  Effect.gen(function* () {
    const captures = make();
    const submission = yield* captures.trackSubmission(threadId, instanceId);
    yield* submission.beforeSubmit(nativeTerminal.turnId);
    yield* captures.observe(nativeTerminal);
    yield* submission.nativeCompleted(nativeTerminal.turnId);
    const confirmed = { ...nativeTerminal, eventId: EventId.make("confirmed-after-synthetic") };
    yield* captures.observe(confirmed);
    const waiting = yield* captures.awaitNativeCapture(threadId).pipe(Effect.forkChild);
    yield* captures.complete(nativeTerminal, "skipped");
    yield* Effect.yieldNow;
    assert.equal(waiting.pollUnsafe(), undefined);
    yield* captures.complete(confirmed, "captured");
    yield* Fiber.join(waiting);
  }),
);

it.effect("keeps each same-turn steering request until its native reply and final capture", () =>
  Effect.gen(function* () {
    const captures = make();
    const first = yield* captures.trackSubmission(threadId, instanceId);
    const steer = yield* captures.trackSubmission(threadId, instanceId);
    yield* first.beforeSubmit(nativeTerminal.turnId);
    yield* steer.beforeSubmit(nativeTerminal.turnId);
    yield* first.nativeCompleted(nativeTerminal.turnId);
    yield* captures.observe(nativeTerminal);
    assert.equal(yield* captures.shouldCapture(nativeTerminal), false);
    yield* captures.complete(nativeTerminal, "skipped");
    yield* steer.nativeCompleted(nativeTerminal.turnId);
    const confirmed = { ...nativeTerminal, eventId: EventId.make("steering-final") };
    yield* captures.observe(confirmed);
    assert.equal(yield* captures.shouldCapture(confirmed), true);
    yield* captures.complete(confirmed, "captured");
    yield* captures.awaitNativeCapture(threadId);
  }),
);

it.effect("binds early Codex receipts only from the exact send response", () =>
  Effect.gen(function* () {
    const captures = make();
    const submission = yield* captures.trackSubmission(threadId, instanceId);
    yield* submission.beforeSubmit();
    yield* submission.nativeCompleted(nativeTerminal.turnId);
    yield* captures.observe(nativeTerminal);
    yield* captures.complete(nativeTerminal, "captured");
    const waiting = yield* captures.awaitNativeCapture(threadId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(waiting.pollUnsafe(), undefined);
    yield* captures.observe({
      ...started,
      providerInstanceId: instanceId,
      turnId: TurnId.make("unrelated"),
    });
    assert.equal((yield* submission.outcome)._tag, "UnknownSubmission");
    yield* submission.accept(nativeTerminal.turnId);
    yield* Fiber.join(waiting);
  }),
);

it.effect("does not release ownership on generic exit or another provider instance", () =>
  Effect.gen(function* () {
    const captures = make();
    const submission = yield* captures.trackSubmission(threadId, instanceId);
    yield* submission.beforeSubmit(nativeTerminal.turnId);
    yield* submission.nativeCompleted(nativeTerminal.turnId);
    const foreign = { ...nativeTerminal, providerInstanceId: ProviderInstanceId.make("other") };
    yield* captures.observe(foreign);
    yield* captures.complete(foreign, "captured");
    yield* captures.observe({
      ...started,
      providerInstanceId: instanceId,
      type: "session.exited",
      payload: {},
    });
    const waiting = yield* captures.awaitNativeCapture(threadId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(waiting.pollUnsafe(), undefined);
    yield* captures.observe(nativeTerminal);
    yield* captures.complete(nativeTerminal, "captured");
    yield* Fiber.join(waiting);
  }),
);

it.effect("releases only a rejected call and permits that call to retry", () =>
  Effect.gen(function* () {
    const captures = make();
    const first = yield* captures.trackSubmission(threadId, instanceId);
    const retry = yield* captures.trackSubmission(threadId, instanceId);
    yield* first.beforeSubmit(nativeTerminal.turnId);
    yield* retry.beforeSubmit(nativeTerminal.turnId);
    yield* retry.notSubmitted;
    assert.equal((yield* retry.outcome)._tag, "NotSubmitted");
    const waiting = yield* retry.beforeSubmit(TurnId.make("retry")).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(waiting.pollUnsafe(), undefined);
    yield* first.nativeCompleted(nativeTerminal.turnId);
    yield* captures.observe(nativeTerminal);
    yield* captures.complete(nativeTerminal, "captured");
    yield* Fiber.join(waiting);
    assert.equal((yield* retry.outcome)._tag, "UnknownSubmission");
    yield* retry.notSubmitted;
  }),
);

it.effect("requires a fresh capture after known-turn native teardown", () =>
  Effect.gen(function* () {
    const captures = make();
    const submission = yield* captures.trackSubmission(threadId, instanceId);
    yield* submission.beforeSubmit(nativeTerminal.turnId);
    yield* captures.observe(nativeTerminal);
    yield* captures.complete(nativeTerminal, "skipped");
    yield* submission.nativeStopped;
    const waiting = yield* captures.awaitNativeCapture(threadId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(waiting.pollUnsafe(), undefined);
    const stopped = { ...nativeTerminal, eventId: EventId.make("confirmed-stop") };
    yield* captures.observe(stopped);
    yield* captures.complete(stopped, "captured");
    yield* Fiber.join(waiting);
    const unknown = yield* captures.trackSubmission(threadId, instanceId);
    yield* unknown.beforeSubmit();
    yield* unknown.nativeStopped;
    yield* captures.awaitNativeCapture(threadId);
  }),
);
