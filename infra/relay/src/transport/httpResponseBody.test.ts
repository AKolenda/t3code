import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  relayHttpResponseBodyStream,
  type RelayHttpResponseBodyEvent,
} from "./httpResponseBody.ts";

describe("relay HTTP response body", () => {
  it.effect("ends normally only for an explicit end event", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(1, 2, 3) });
      yield* Queue.offer(queue, { type: "end" });

      const chunks = yield* Stream.runCollect(relayHttpResponseBodyStream(queue));
      expect([...chunks].map((chunk) => [...chunk])).toEqual([[1, 2, 3]]);
    }),
  );

  it.effect("fails rather than returning a truncated success body after an abort", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(1, 2, 3) });
      yield* Queue.offer(queue, { type: "abort", reason: "connector disconnected" });

      const exit = yield* Effect.exit(Stream.runCollect(relayHttpResponseBodyStream(queue)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toMatch(/connector disconnected/u);
      }
    }),
  );

  it.effect("aborts when no chunk arrives within the idle timeout", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
      const fiber = yield* Stream.runCollect(relayHttpResponseBodyStream(queue, "10 seconds")).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      // A slow reader that keeps receiving chunks never trips the timeout.
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(1) });
      yield* TestClock.adjust("8 seconds");
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(2) });
      yield* TestClock.adjust("8 seconds");
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(3) });
      // A stalled one does.
      yield* TestClock.adjust("11 seconds");

      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toMatch(/idle timeout/u);
      }
    }),
  );
});
