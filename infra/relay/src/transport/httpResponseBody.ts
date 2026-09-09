import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export type RelayHttpResponseBodyEvent =
  | { readonly type: "chunk"; readonly bytes: Uint8Array }
  | { readonly type: "end" }
  | { readonly type: "abort"; readonly reason: string };

/**
 * An in-flight HTTP response keeps the Durable Object awake and billed. A
 * slow client is fine because it keeps pulling chunks, but a client that
 * stops reading stalls the stream on flow control forever. Bound the wait
 * between chunks, not the total download, so a large file on a slow link
 * still completes while an abandoned one is released.
 */
export const RELAY_HTTP_RESPONSE_IDLE_TIMEOUT: Duration.Input = "60 seconds";

export function relayHttpResponseBodyStream(
  queue: Queue.Queue<RelayHttpResponseBodyEvent>,
  idleTimeout: Duration.Input = RELAY_HTTP_RESPONSE_IDLE_TIMEOUT,
): Stream.Stream<Uint8Array> {
  return Stream.fromQueue(queue).pipe(
    Stream.timeoutOrElse({
      duration: idleTimeout,
      orElse: () =>
        Stream.fail(new Error("Relay HTTP response aborted: no data for the idle timeout")),
    }),
    Stream.orDie,
    Stream.takeWhile((event) => event.type !== "end"),
    Stream.mapEffect((event) =>
      event.type === "chunk"
        ? Effect.succeed(event.bytes)
        : Effect.die(new Error(`Relay HTTP response aborted: ${event.reason}`)),
    ),
  );
}
