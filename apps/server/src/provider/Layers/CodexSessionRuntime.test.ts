import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import * as TurnCheckpointCapture from "../../checkpointing/TurnCheckpointCapture.ts";
import {
  buildTurnStartParams,
  describeMcpElicitation,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  makeCodexSessionRuntime,
  openCodexThread,
  toMcpElicitationResponse,
} from "./CodexSessionRuntime.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const decodeTurnStartParams = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartParams);

const NativeRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const decodeNativeRequest = Schema.decodeSync(Schema.fromJsonString(NativeRequest));
const encodeNativeMessage = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeAdmissionRuntime = Effect.fn("makeAdmissionRuntime")(function* (options?: {
  readonly exitSignal?: "SIGTERM" | "SIGKILL";
  readonly exitStatusError?: boolean;
}) {
  const incoming = yield* Queue.unbounded<Uint8Array>();
  const requests = yield* Queue.unbounded<typeof NativeRequest.Type>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>();
  const runtimeScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const nativeRuntimeClosed = yield* Deferred.make<void>();
  yield* Scope.addFinalizer(runtimeScope, Deferred.succeed(nativeRuntimeClosed, undefined));
  const observed: Array<string> = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const write = (message: unknown) =>
    Queue.offer(incoming, encoder.encode(`${encodeNativeMessage(message)}\n`)).pipe(Effect.asVoid);
  const respond = (request: typeof NativeRequest.Type, result: unknown) =>
    write({ id: request.id, result });
  let remainder = "";
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Deferred.await(exited),
    isRunning: Deferred.isDone(exited).pipe(
      Effect.map((done) => !done || options?.exitStatusError === true),
    ),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        const lines = (remainder + decoder.decode(chunk, { stream: true })).split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          const request = decodeNativeRequest(line);
          observed.push(request.method);
          if (request.method === "initialize") {
            yield* respond(request, {
              userAgent: "admission-test",
              codexHome: "/tmp",
              platformFamily: "unix",
              platformOs: "linux",
            });
          } else if (request.method === "thread/start") {
            yield* respond(request, wireFixture.responses.threadStart);
          } else if (request.id !== undefined) {
            yield* Queue.offer(requests, request);
          }
        }
      }),
    ),
    stdout: Stream.fromQueue(incoming),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  const runtime = yield* makeCodexSessionRuntime({
    threadId: ThreadId.make("admission-test"),
    binaryPath: "codex",
    cwd: process.cwd(),
    runtimeMode: "full-access",
    appServerArgs: ["-c", "mcp_servers.test.url=http://127.0.0.1/mcp"],
  }).pipe(
    Effect.provideService(Scope.Scope, runtimeScope),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
    ),
  );
  yield* runtime.start();
  return {
    runtime,
    nativeRuntimeClosed: Deferred.await(nativeRuntimeClosed),
    nativeExit:
      options?.exitSignal || options?.exitStatusError
        ? Deferred.fail(
            exited,
            PlatformError.systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "exitCode",
              cause: new Error(
                options.exitSignal
                  ? `Process interrupted due to receipt of signal: '${options.exitSignal}'`
                  : "Could not read exit status",
              ),
            }),
          )
        : Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)),
    observed,
    respond,
    reject: (request: typeof NativeRequest.Type, code: number, message: string) =>
      write({ id: request.id, error: { code, message } }),
    nextRequest: Effect.fnUntraced(function* (method: string) {
      const request = yield* Queue.take(requests);
      NodeAssert.equal(request.method, method);
      return request;
    }),
    complete: (turnId: string, threadId = wireFixture.rootThreadId) =>
      write({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
      }),
    marker: write({
      method: "serverRequest/resolved",
      params: { threadId: wireFixture.rootThreadId, requestId: "terminal-drained" },
    }),
  };
});

describe("Codex native turn admission", () => {
  it.effect("steers the exact active turn and keeps settings for the next admitted turn", () =>
    Effect.gen(function* () {
      const { runtime, observed, respond, nextRequest, complete } = yield* makeAdmissionRuntime();
      const completed: Array<string> = [];
      const terminal = yield* Deferred.make<void>();
      const first = yield* runtime
        .sendTurn(
          { input: "first", model: "gpt-5.4" },
          {
            beforeSubmit: () => Effect.void,
            notSubmitted: Effect.die("first input was submitted"),
            nativeStopped: Effect.void,
            nativeCompleted: (turnId) =>
              Effect.sync(() => {
                completed.push(`first:${turnId}`);
              }),
          },
        )
        .pipe(Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      const firstRequest = yield* nextRequest("turn/start");
      yield* respond(firstRequest, {
        turn: { id: "active-turn", status: "inProgress", items: [] },
      });
      yield* Fiber.join(first);

      const steer = yield* runtime
        .sendTurn(
          {
            input: "follow-up",
            model: "gpt-5.3-codex",
            effort: "high",
            serviceTier: "fast",
            interactionMode: "plan",
          },
          {
            beforeSubmit: (turnId) =>
              Effect.sync(() => {
                NodeAssert.equal(turnId, "active-turn");
              }),
            notSubmitted: Effect.die("steering was submitted"),
            nativeStopped: Effect.void,
            nativeCompleted: (turnId) =>
              Effect.gen(function* () {
                completed.push(`steer:${turnId}`);
                yield* Deferred.succeed(terminal, undefined);
              }),
          },
        )
        .pipe(Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      const steerRequest = yield* nextRequest("turn/steer");
      NodeAssert.deepStrictEqual(steerRequest.params, {
        threadId: wireFixture.rootThreadId,
        expectedTurnId: "active-turn",
        input: [{ type: "text", text: "follow-up" }],
      });
      yield* respond(steerRequest, { turnId: "active-turn" });
      NodeAssert.equal((yield* Fiber.join(steer)).turnId, "active-turn");
      yield* complete("active-turn");
      yield* Deferred.await(terminal);
      NodeAssert.deepStrictEqual(completed, ["first:active-turn", "steer:active-turn"]);

      const captureReady = yield* Deferred.make<void>();
      const parked = yield* Deferred.make<void>();
      const next = yield* runtime
        .sendTurn(
          { input: "next turn" },
          {
            beforeSubmit: (turnId) =>
              Effect.gen(function* () {
                NodeAssert.equal(turnId, undefined);
                yield* Deferred.succeed(parked, undefined);
                yield* Deferred.await(captureReady);
              }),
            notSubmitted: Effect.void,
            nativeStopped: Effect.void,
            nativeCompleted: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      yield* Deferred.await(parked);
      NodeAssert.equal(observed.filter((method) => method === "turn/start").length, 1);
      yield* Deferred.succeed(captureReady, undefined);
      const nextStart = yield* nextRequest("turn/start");
      NodeAssert.deepStrictEqual(
        nextStart.params,
        yield* buildTurnStartParams({
          threadId: wireFixture.rootThreadId,
          runtimeMode: "full-access",
          prompt: "next turn",
          model: "gpt-5.3-codex",
          effort: "high",
          serviceTier: "fast",
          interactionMode: "plan",
        }),
      );
      yield* respond(nextStart, { turn: { id: "next-turn", status: "inProgress", items: [] } });
      NodeAssert.equal((yield* Fiber.join(next)).turnId, "next-turn");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "applies steering defaults before a delayed response and ignores its stale session update",
    () =>
      Effect.gen(function* () {
        const { runtime, respond, nextRequest, complete } = yield* makeAdmissionRuntime();
        const first = yield* runtime
          .sendTurn({ input: "first", model: "gpt-5.4" })
          .pipe(Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        yield* respond(yield* nextRequest("turn/start"), {
          turn: { id: "old-turn", status: "inProgress", items: [] },
        });
        yield* Fiber.join(first);
        const terminal = yield* Deferred.make<void>();
        const steer = yield* runtime
          .sendTurn(
            { input: "follow-up", model: "gpt-5.3-codex", effort: "high" },
            {
              beforeSubmit: () => Effect.void,
              notSubmitted: Effect.void,
              nativeStopped: Effect.void,
              nativeCompleted: () => Deferred.succeed(terminal, undefined).pipe(Effect.asVoid),
            },
          )
          .pipe(Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        const delayedResponse = yield* nextRequest("turn/steer");
        yield* complete("old-turn");
        yield* Deferred.await(terminal);
        const next = yield* runtime.sendTurn({ input: "next turn" }).pipe(Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        const nextStart = yield* nextRequest("turn/start");
        const nextParams = yield* decodeTurnStartParams(nextStart.params);
        NodeAssert.equal(nextParams.model, "gpt-5.3-codex");
        NodeAssert.equal(nextParams.effort, "high");
        yield* respond(nextStart, { turn: { id: "new-turn", status: "inProgress", items: [] } });
        yield* Fiber.join(next);
        const newer = yield* runtime
          .sendTurn({ input: "newer selection", model: "gpt-5.4", effort: "low" })
          .pipe(Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        yield* respond(yield* nextRequest("turn/steer"), { turnId: "new-turn" });
        yield* Fiber.join(newer);
        yield* respond(delayedResponse, { turnId: "old-turn" });
        yield* Fiber.join(steer);
        const session = yield* runtime.getSession;
        NodeAssert.equal(session.activeTurnId, "new-turn");
        NodeAssert.equal(session.model, "gpt-5.4");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const rejection of [
    "no active turn to steer",
    "expected active turn id `old-turn` but found `other-turn`",
  ]) {
    it.effect(`requires fresh new-turn admission after steering rejects: ${rejection}`, () =>
      Effect.gen(function* () {
        const { runtime, observed, respond, reject, nextRequest, complete } =
          yield* makeAdmissionRuntime();
        const first = yield* runtime.sendTurn({ input: "first" }).pipe(Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        yield* respond(yield* nextRequest("turn/start"), {
          turn: { id: "old-turn", status: "inProgress", items: [] },
        });
        yield* Fiber.join(first);
        const captureReady = yield* Deferred.make<void>();
        const parked = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        const calls: Array<string | undefined> = [];
        const send = yield* runtime
          .sendTurn(
            { input: "follow-up" },
            {
              beforeSubmit: (turnId) =>
                Effect.gen(function* () {
                  calls.push(turnId);
                  if (turnId === undefined) {
                    yield* Deferred.succeed(parked, undefined);
                    yield* Deferred.await(captureReady);
                  }
                }),
              notSubmitted: Effect.sync(() => {
                calls.push("not-submitted");
              }),
              nativeStopped: Effect.void,
              nativeCompleted: () => Deferred.succeed(terminal, undefined).pipe(Effect.asVoid),
            },
          )
          .pipe(Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        const steer = yield* nextRequest("turn/steer");
        yield* complete("old-turn");
        yield* Deferred.await(terminal);
        yield* reject(steer, -32600, rejection);
        yield* Deferred.await(parked);
        NodeAssert.deepStrictEqual(calls, ["old-turn", "not-submitted", undefined]);
        NodeAssert.equal(observed.filter((method) => method === "turn/start").length, 1);
        yield* Deferred.succeed(captureReady, undefined);
        yield* respond(yield* nextRequest("turn/start"), {
          turn: { id: "new-turn", status: "inProgress", items: [] },
        });
        NodeAssert.equal((yield* Fiber.join(send)).turnId, "new-turn");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("confirms native stop for the original turn and an uncertain steering claim", () =>
    Effect.gen(function* () {
      const { runtime, respond, nextRequest, nativeExit } = yield* makeAdmissionRuntime();
      const stopped: Array<string> = [];
      const first = yield* runtime
        .sendTurn(
          { input: "first" },
          {
            beforeSubmit: () => Effect.void,
            notSubmitted: Effect.void,
            nativeStopped: Effect.sync(() => {
              stopped.push("first");
            }),
            nativeCompleted: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      yield* respond(yield* nextRequest("turn/start"), {
        turn: { id: "active-turn", status: "inProgress", items: [] },
      });
      yield* Fiber.join(first);
      const steer = yield* runtime
        .sendTurn(
          { input: "follow-up" },
          {
            beforeSubmit: () => Effect.void,
            notSubmitted: Effect.die("steering outcome is unknown"),
            nativeStopped: Effect.sync(() => {
              stopped.push("steer");
            }),
            nativeCompleted: () => Effect.void,
          },
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      yield* respond(yield* nextRequest("turn/steer"), {});
      NodeAssert.equal((yield* Fiber.join(steer))._tag, "Failure");
      yield* nativeExit;
      yield* runtime.close;
      NodeAssert.deepStrictEqual(stopped, ["first", "steer"]);
      const events = yield* Stream.runCollect(runtime.events);
      NodeAssert.deepStrictEqual(
        events.filter((event) => event.method === "turn/aborted").map((event) => event.turnId),
        ["active-turn"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const outcome of ["bad-response", "request-error"] as const) {
    it.effect(`does not start a duplicate turn after an uncertain steer ${outcome}`, () =>
      Effect.gen(function* () {
        const { runtime, observed, respond, reject, nextRequest, complete } =
          yield* makeAdmissionRuntime();
        const first = yield* runtime.sendTurn({ input: "first" }).pipe(Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        yield* respond(yield* nextRequest("turn/start"), {
          turn: { id: "active-turn", status: "inProgress", items: [] },
        });
        yield* Fiber.join(first);
        const terminal = yield* Deferred.make<void>();
        const send = yield* runtime
          .sendTurn(
            { input: "follow-up" },
            {
              beforeSubmit: (turnId) =>
                Effect.sync(() => {
                  NodeAssert.equal(turnId, "active-turn");
                }),
              notSubmitted: Effect.die("uncertain steering cannot release admission"),
              nativeStopped: Effect.void,
              nativeCompleted: (turnId) =>
                Effect.gen(function* () {
                  NodeAssert.equal(turnId, "active-turn");
                  yield* Deferred.succeed(terminal, undefined);
                }),
            },
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        const steer = yield* nextRequest("turn/steer");
        if (outcome === "bad-response") {
          yield* respond(steer, { turnId: "wrong-turn" });
        } else {
          yield* reject(steer, -32603, "could not read native result");
        }
        NodeAssert.equal((yield* Fiber.join(send))._tag, "Failure");
        NodeAssert.equal(observed.filter((method) => method === "turn/start").length, 1);
        yield* complete("active-turn");
        yield* Deferred.await(terminal);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("waits after MCP reload when the old turn completes during preparation", () =>
    Effect.gen(function* () {
      const { runtime, observed, respond, nextRequest, complete } = yield* makeAdmissionRuntime();
      const oldTerminal = yield* Deferred.make<void>();
      const first = yield* runtime
        .sendTurn(
          { input: "first" },
          {
            beforeSubmit: () => Effect.void,
            notSubmitted: Effect.die("first turn was submitted"),
            nativeStopped: Effect.void,
            nativeCompleted: (turnId) => {
              NodeAssert.equal(turnId, "old-turn");
              return Deferred.succeed(oldTerminal, undefined).pipe(Effect.asVoid);
            },
          },
        )
        .pipe(Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      yield* respond(yield* nextRequest("turn/start"), {
        turn: { id: "old-turn", status: "inProgress", items: [] },
      });
      yield* Fiber.join(first);

      const captureReady = yield* Deferred.make<void>();
      const admissionReached = yield* Deferred.make<void>();
      const second = yield* runtime
        .sendTurn(
          { input: "follow-up" },
          {
            beforeSubmit: (turnId) =>
              Effect.gen(function* () {
                NodeAssert.equal(turnId, undefined);
                yield* Deferred.succeed(admissionReached, undefined);
                yield* Deferred.await(captureReady);
              }),
            notSubmitted: Effect.die("follow-up was submitted"),
            nativeStopped: Effect.void,
            nativeCompleted: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild);
      const reload = yield* nextRequest("config/mcpServer/reload");
      yield* complete("old-turn");
      yield* Deferred.await(oldTerminal);
      NodeAssert.equal(yield* Deferred.isDone(admissionReached), false);
      yield* respond(reload, {});
      yield* Deferred.await(admissionReached);
      NodeAssert.equal(observed.filter((method) => method === "turn/start").length, 1);
      yield* Deferred.succeed(captureReady, undefined);
      yield* respond(yield* nextRequest("turn/start"), {
        turn: { id: "new-turn", status: "inProgress", items: [] },
      });
      NodeAssert.equal((yield* Fiber.join(second)).turnId, "new-turn");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const response of [
    { turn: { id: "native-turn" } },
    { turn: { id: "native-turn", status: "future-status", items: "future-shape" } },
  ]) {
    it.effect(
      `accepts a correlated turn id without requiring unused response fields: ${Object.keys(response.turn).join(",")}`,
      () =>
        Effect.gen(function* () {
          const { runtime, respond, nextRequest, complete } = yield* makeAdmissionRuntime();
          const captures = TurnCheckpointCapture.make();
          const threadId = ThreadId.make("admission-test");
          const instanceId = ProviderInstanceId.make("codex-test");
          const submission = yield* captures.trackSubmission(threadId, instanceId);
          const terminal = yield* Deferred.make<void>();
          const send = yield* runtime
            .sendTurn(
              { input: "change files" },
              {
                ...submission,
                nativeCompleted: (turnId) =>
                  submission
                    .nativeCompleted(turnId)
                    .pipe(Effect.andThen(Deferred.succeed(terminal, undefined))),
              },
            )
            .pipe(
              Effect.tap((turn) => submission.accept(turn.turnId)),
              Effect.forkChild,
            );
          yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
          yield* respond(yield* nextRequest("turn/start"), response);
          NodeAssert.equal((yield* Fiber.join(send)).turnId, "native-turn");
          NodeAssert.deepStrictEqual(yield* submission.outcome, {
            _tag: "Accepted",
            turnId: "native-turn",
          });
          yield* complete("native-turn");
          yield* Deferred.await(terminal);
          const canonicalTerminal = {
            type: "turn.completed" as const,
            eventId: EventId.make("native-terminal"),
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            threadId,
            turnId: TurnId.make("native-turn"),
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: { state: "completed" as const },
          };
          yield* captures.observe(canonicalTerminal);
          NodeAssert.equal(yield* captures.nativeCaptureReady(canonicalTerminal), true);
          const nextSubmission = yield* captures.trackSubmission(threadId, instanceId);
          const next = yield* runtime
            .sendTurn({ input: "next turn" }, nextSubmission)
            .pipe(Effect.forkChild);
          yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
          yield* captures.complete(canonicalTerminal, "captured");
          yield* respond(yield* nextRequest("turn/start"), { turn: { id: "next-turn" } });
          NodeAssert.equal((yield* Fiber.join(next)).turnId, "next-turn");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  for (const invalidId of [undefined, "", " ", " native-turn ", 42]) {
    it.effect(
      `keeps unknown identity until native stop after invalid acknowledgement id: ${String(invalidId)}`,
      () =>
        Effect.gen(function* () {
          const { runtime, respond, nextRequest, complete, nativeExit } =
            yield* makeAdmissionRuntime();
          const captures = TurnCheckpointCapture.make();
          const threadId = ThreadId.make("admission-test");
          const instanceId = ProviderInstanceId.make("codex-test");
          const submission = yield* captures.trackSubmission(threadId, instanceId);
          const terminal = yield* Deferred.make<void>();
          const completed: Array<TurnId> = [];
          const send = yield* runtime
            .sendTurn(
              { input: "change files" },
              {
                ...submission,
                nativeCompleted: (turnId) =>
                  Effect.gen(function* () {
                    completed.push(turnId);
                    yield* submission.nativeCompleted(turnId);
                    yield* Deferred.succeed(terminal, undefined);
                  }),
              },
            )
            .pipe(Effect.result, Effect.forkChild);
          yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
          yield* respond(yield* nextRequest("turn/start"), { turn: { id: invalidId } });
          const result = yield* Fiber.join(send);
          NodeAssert.equal(result._tag, "Failure");
          NodeAssert.equal(result.failure._tag, "CodexAppServerProtocolParseError");
          NodeAssert.deepStrictEqual(yield* submission.outcome, {
            _tag: "UnknownSubmission",
            turnId: undefined,
          });
          yield* complete("child-turn", "child-thread");
          yield* complete("native-turn");
          yield* Deferred.await(terminal);
          NodeAssert.deepStrictEqual(completed, ["native-turn"]);
          const canonicalTerminal = {
            type: "turn.completed" as const,
            eventId: EventId.make("unknown-native-terminal"),
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            threadId,
            turnId: TurnId.make("native-turn"),
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: { state: "completed" as const },
          };
          yield* captures.observe(canonicalTerminal);
          yield* captures.complete(canonicalTerminal, "captured");
          const released = yield* Deferred.make<void>();
          const wait = yield* captures
            .awaitNativeCapture(threadId)
            .pipe(
              Effect.andThen(Deferred.succeed(released, undefined)),
              Effect.forkChild({ startImmediately: true }),
            );
          NodeAssert.equal(yield* Deferred.isDone(released), false);
          yield* nativeExit;
          yield* runtime.close;
          yield* Fiber.join(wait);
          NodeAssert.equal(yield* Deferred.isDone(released), true);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("can cancel a parked send even when its caller is uninterruptible", () =>
    Effect.gen(function* () {
      const { runtime, observed, respond, nextRequest } = yield* makeAdmissionRuntime();
      const captures = TurnCheckpointCapture.make();
      const threadId = ThreadId.make("admission-test");
      const instanceId = ProviderInstanceId.make("codex-test");
      const oldTerminal = {
        type: "turn.completed" as const,
        eventId: EventId.make("old-terminal"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        threadId,
        turnId: TurnId.make("old-turn"),
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { state: "completed" as const },
      };
      yield* captures.observe(oldTerminal);
      const submission = yield* captures.trackSubmission(threadId, instanceId);
      const parked = yield* Deferred.make<void>();
      const send = yield* runtime
        .sendTurn(
          { input: "do not submit" },
          {
            ...submission,
            beforeSubmit: (turnId) =>
              Deferred.succeed(parked, undefined).pipe(
                Effect.andThen(submission.beforeSubmit(turnId)),
              ),
          },
        )
        .pipe(Effect.uninterruptible, Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      yield* Deferred.await(parked);
      NodeAssert.deepStrictEqual(yield* submission.outcome, { _tag: "NotSubmitted" });
      yield* Fiber.interrupt(send);
      NodeAssert.equal(Exit.hasInterrupts(yield* Fiber.await(send)), true);
      NodeAssert.equal(observed.includes("turn/start"), false);
      NodeAssert.deepStrictEqual(yield* submission.outcome, { _tag: "NotSubmitted" });
      yield* captures.complete(oldTerminal, "captured");
      const nextSubmission = yield* captures.trackSubmission(threadId, instanceId);
      const next = yield* runtime
        .sendTurn({ input: "submit after capture" }, nextSubmission)
        .pipe(Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      yield* respond(yield* nextRequest("turn/start"), {
        turn: { id: "new-turn", status: "inProgress", items: [] },
      });
      yield* nextSubmission.accept((yield* Fiber.join(next)).turnId);
      NodeAssert.deepStrictEqual(yield* nextSubmission.outcome, {
        _tag: "Accepted",
        turnId: "new-turn",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a native terminal before the turn start response arrives", () =>
    Effect.gen(function* () {
      const { runtime, respond, nextRequest, complete } = yield* makeAdmissionRuntime();
      const terminal = yield* Deferred.make<TurnId>();
      const send = yield* runtime
        .sendTurn(
          { input: "fast turn" },
          {
            beforeSubmit: () => Effect.void,
            notSubmitted: Effect.die("native work was submitted"),
            nativeStopped: Effect.void,
            nativeCompleted: (turnId) => Deferred.succeed(terminal, turnId).pipe(Effect.asVoid),
          },
        )
        .pipe(Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      const request = yield* nextRequest("turn/start");
      yield* complete("fast-turn");
      NodeAssert.equal(yield* Deferred.await(terminal), "fast-turn");
      yield* respond(request, { turn: { id: "fast-turn", status: "completed", items: [] } });
      NodeAssert.equal((yield* Fiber.join(send)).turnId, "fast-turn");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const completion of [
    "missing",
    "before-response",
    "after-response",
    "blocked-callback",
    "late-callback",
  ] as const) {
    it.effect(`finishes a stopped accepted turn with native completion ${completion}`, () =>
      Effect.gen(function* () {
        const { runtime, respond, nextRequest, complete, nativeExit, marker } =
          yield* makeAdmissionRuntime({ exitSignal: "SIGTERM" });
        const nativeTerminal = yield* Deferred.make<void>();
        const canonicalTerminal = yield* Deferred.make<void>();
        const releaseCallback = yield* Deferred.make<void>();
        const abortQueued = yield* Deferred.make<void>();
        const markerQueued = yield* Deferred.make<void>();
        const ordering: Array<string> = [];
        const events = yield* runtime.events.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (event.method === "turn/aborted") {
                ordering.push("aborted");
                yield* Deferred.succeed(abortQueued, undefined);
              }
              if (event.method === "turn/completed")
                yield* Deferred.succeed(canonicalTerminal, undefined);
              if (event.method === "session/closed") ordering.push("closed");
              if (event.method === "serverRequest/resolved")
                yield* Deferred.succeed(markerQueued, undefined);
            }),
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        const send = yield* runtime
          .sendTurn(
            { input: "accepted turn" },
            {
              beforeSubmit: () => Effect.void,
              notSubmitted: Effect.die("native work was submitted"),
              nativeStopped: Effect.sync(() => {
                ordering.push("proof");
              }),
              nativeCompleted: () =>
                Deferred.succeed(nativeTerminal, undefined).pipe(
                  Effect.andThen(
                    completion === "blocked-callback"
                      ? Effect.never
                      : completion === "late-callback"
                        ? Deferred.await(releaseCallback)
                        : Effect.void,
                  ),
                ),
            },
          )
          .pipe(Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        const request = yield* nextRequest("turn/start");
        if (completion === "before-response") {
          yield* complete("accepted-turn");
          yield* Deferred.await(nativeTerminal);
        }
        yield* respond(request, { turn: { id: "accepted-turn", status: "inProgress", items: [] } });
        yield* Fiber.join(send);
        if (
          completion === "after-response" ||
          completion === "blocked-callback" ||
          completion === "late-callback"
        ) {
          yield* complete("accepted-turn");
          yield* Deferred.await(nativeTerminal);
        }
        if (completion === "before-response" || completion === "after-response")
          yield* Deferred.await(canonicalTerminal);
        yield* nativeExit;
        if (completion === "late-callback") {
          yield* Deferred.await(abortQueued);
          yield* Deferred.succeed(releaseCallback, undefined);
          yield* marker;
          yield* Deferred.await(markerQueued);
        }
        yield* runtime.close;
        const collectedEvents = yield* Fiber.join(events);
        const terminalEvents = collectedEvents.filter((event) => event.method === "turn/aborted");
        const needsAbort =
          completion === "missing" ||
          completion === "blocked-callback" ||
          completion === "late-callback";
        NodeAssert.equal(terminalEvents.length, needsAbort ? 1 : 0);
        NodeAssert.equal(
          collectedEvents.filter((event) => event.method === "turn/completed").length,
          needsAbort ? 0 : 1,
        );
        if (needsAbort) NodeAssert.equal(terminalEvents[0]?.turnId, "accepted-turn");
        NodeAssert.deepEqual(
          ordering,
          needsAbort ? ["proof", "aborted", "closed"] : ["proof", "closed"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  for (const scenario of [
    { name: "exit code 0", options: {}, stopped: true },
    { name: "SIGTERM", options: { exitSignal: "SIGTERM" as const }, stopped: true },
    { name: "SIGKILL", options: { exitSignal: "SIGKILL" as const }, stopped: true },
    {
      name: "an exit-status error while still running",
      options: { exitStatusError: true },
      stopped: false,
    },
  ]) {
    it.effect(`checks captured process exit after ${scenario.name}`, () =>
      Effect.gen(function* () {
        const { runtime, respond, nextRequest, nativeExit, nativeRuntimeClosed } =
          yield* makeAdmissionRuntime(scenario.options);
        let stopped = false;
        const send = yield* runtime
          .sendTurn(
            { input: "uncertain turn" },
            {
              beforeSubmit: () => Effect.void,
              notSubmitted: Effect.die("native work was submitted"),
              nativeStopped: Effect.sync(() => {
                stopped = true;
              }),
              nativeCompleted: () => Effect.die("no native terminal was received"),
            },
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
        yield* respond(yield* nextRequest("turn/start"), { turn: {} });
        NodeAssert.equal((yield* Fiber.join(send))._tag, "Failure");
        const close = yield* runtime.close.pipe(Effect.forkChild);
        yield* nativeRuntimeClosed;
        NodeAssert.equal(stopped, false);
        yield* nativeExit;
        yield* Fiber.join(close);
        NodeAssert.equal(stopped, scenario.stopped);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("rejects a parked send after its native process exits", () =>
    Effect.gen(function* () {
      const { runtime, observed, respond, nextRequest, nativeExit } = yield* makeAdmissionRuntime();
      const parked = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let notSubmitted = false;
      const send = yield* runtime
        .sendTurn(
          { input: "do not send after exit" },
          {
            beforeSubmit: () =>
              Deferred.succeed(parked, undefined).pipe(Effect.andThen(Deferred.await(released))),
            notSubmitted: Effect.sync(() => {
              notSubmitted = true;
            }),
            nativeStopped: Effect.void,
            nativeCompleted: () => Effect.die("no native work exists"),
          },
        )
        .pipe(Effect.forkChild);
      yield* respond(yield* nextRequest("config/mcpServer/reload"), {});
      yield* Deferred.await(parked);
      const exitedEvent = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "session/exited"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* nativeExit;
      yield* Fiber.join(exitedEvent);
      yield* Deferred.succeed(released, undefined);
      NodeAssert.equal(Exit.hasInterrupts(yield* Fiber.await(send)), true);
      NodeAssert.equal(notSubmitted, true);
      NodeAssert.equal(observed.includes("turn/start"), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.match(instructions, /^<collaboration_mode># Collaboration Mode: Default/);
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("describes Markdown media support in the runtime context in both modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images and videos.*Markdown.*<\/runtime_info>/,
      );
    }
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.match(instructions, /^<collaboration_mode># Plan Mode/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, runtime, true);
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, runtime, false);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
      // Steering away from other browser automation must go with the tools;
      // keeping it would leave the model talked out of its only option.
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      // The rest of the collaboration mode is untouched.
      NodeAssert.match(instructions, /<collaboration_mode>/);
      NodeAssert.match(instructions, /<\/collaboration_mode>/);
    }
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    NodeAssert.match(buildCodexDeveloperInstructions("default", runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(
      buildCodexDeveloperInstructions("default", runtime, false),
      /preview_open/,
    );
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
