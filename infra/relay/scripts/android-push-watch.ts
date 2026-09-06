// @effect-diagnostics nodeBuiltinImport:off - Local developer verification reads private credential files.
import * as NodeFSP from "node:fs/promises";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { RelayConfiguration } from "../src/Config.ts";
import { androidActivityData, fitFcmData } from "../src/agentActivity/fcmPayloads.ts";
import { FcmClient, layer as fcmLayer } from "../src/agentActivity/FcmClient.ts";
import { androidAlertForState } from "../src/agentActivity/FcmDeliveries.ts";
import { makeAggregateState } from "../src/agentActivity/agentActivityAggregate.ts";

const Device = Schema.Struct({
  token: Schema.NonEmptyString,
  deviceId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  packageName: Schema.NonEmptyString,
});
const Connection = Schema.Struct({
  wsUrl: Schema.NonEmptyString,
  bearerToken: Schema.NonEmptyString,
});
const readFile = (path: string) => Effect.tryPromise(() => NodeFSP.readFile(path, "utf8"));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
class WatchError extends Schema.TaggedErrorClass<WatchError>()("AndroidPushWatchError", {
  message: Schema.String,
}) {}
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

const main = Effect.gen(function* () {
  const [credentialsPath, devicePath, connectionPath] = process.argv.slice(2);
  if (!credentialsPath || !devicePath || !connectionPath) {
    return yield* Effect.logError(
      "Usage: node scripts/android-push-watch.ts <service-account.json> <device.json> <connection.json>",
    );
  }
  const credentials = yield* readFile(credentialsPath);
  const device = yield* readFile(devicePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Device))),
  );
  const connection = yield* readFile(connectionPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Connection))),
  );
  const socketConstructor = Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeSocket.NodeWS.WebSocket(url, protocols, {
        headers: { authorization: `Bearer ${connection.bearerToken}` },
      }) as unknown as globalThis.WebSocket,
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(connection.wsUrl).pipe(Layer.provide(socketConstructor))),
    Layer.provide(RpcSerialization.layerJson),
  );
  const fcm = fcmLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        Layer.succeed(RelayConfiguration, {
          relayIssuer: "http://localhost",
          apns: null,
          fcmServiceAccount: Redacted.make(credentials),
          clerkSecretKey: Redacted.make(""),
          clerkPublishableKey: "",
          clerkJwtAudience: "",
          apnsDeliveryJobSigningSecret: Redacted.make(""),
          cloudMintPrivateKey: Redacted.make(""),
          cloudMintPublicKey: "",
          managedEndpointBaseDomain: undefined,
          managedEndpointNamespace: undefined,
        }),
      ),
    ),
  );
  yield* Effect.gen(function* () {
    const rpc = yield* RpcClient.make(WsRpcGroup);
    const sender = yield* FcmClient;
    const config = yield* rpc[WS_METHODS.serverGetConfig]({});
    const projects = new Map<string, OrchestrationProjectShell>();
    const threads = new Map<string, OrchestrationThreadShell>();
    let states = new Map<string, RelayAgentActivityState>();
    let previouslyActive = false;
    yield* Effect.logInfo("Watching this paired environment for Android push verification.");
    yield* rpc[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (item) {
          switch (item.kind) {
            case "synchronized":
              return;
            case "snapshot":
              projects.clear();
              threads.clear();
              for (const project of item.snapshot.projects) projects.set(project.id, project);
              for (const thread of item.snapshot.threads) threads.set(thread.id, thread);
              break;
            case "project-upserted":
              projects.set(item.project.id, item.project);
              break;
            case "project-removed":
              projects.delete(item.projectId);
              break;
            case "thread-upserted":
              threads.set(item.thread.id, item.thread);
              break;
            case "thread-removed":
              threads.delete(item.threadId);
              break;
          }
          const next = new Map<string, RelayAgentActivityState>();
          for (const thread of threads.values()) {
            const project = projects.get(thread.projectId);
            if (!project || thread.archivedAt) continue;
            const state = projectThreadAwareness({
              environmentId: config.environment.environmentId,
              project,
              thread,
            });
            if (state) next.set(thread.id, state);
          }
          const state = item.kind === "thread-upserted" ? next.get(item.thread.id) : undefined;
          const previous = state ? states.get(state.threadId) : undefined;
          // A fresh subscription restores ongoing work without announcing old completions.
          const now = yield* Clock.currentTimeMillis;
          const alert =
            state && state.phase !== previous?.phase && item.kind !== "snapshot"
              ? androidAlertForState(state, preferences, now)
              : null;
          const aggregate = makeAggregateState({
            activeStates: [...next.values()],
            terminalState: null,
            nowMs: now,
          });
          const active = (aggregate?.activeCount ?? 0) > 0;
          const same =
            encodeJson([...next.values()].map(({ updatedAt: _, ...value }) => value)) ===
            encodeJson([...states.values()].map(({ updatedAt: _, ...value }) => value));
          states = next;
          if ((!active && !previouslyActive && !alert) || (same && !alert)) return;
          const result = yield* sender.send({
            token: device.token,
            packageName: device.packageName,
            alert: alert !== null,
            data: fitFcmData({
              t3_kind: "agent_activity",
              device_id: device.deviceId,
              user_id: device.userId,
              updated_at: String(now),
              ...androidActivityData(aggregate),
              ...alert,
            }),
          });
          if (result.unregistered)
            return yield* new WatchError({ message: "Device token is no longer registered" });
          previouslyActive = active;
          yield* Effect.logInfo(
            `Android push accepted: ${state?.phase ?? (active ? "active" : "ended")}`,
          );
        }),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(protocol, fcm)));
});

NodeRuntime.runMain(
  main.pipe(
    Effect.scoped,
    // Socket failures may contain credential-bearing request headers.
    Effect.catchCause(() =>
      Effect.fail(
        new WatchError({
          message:
            "Android push watcher stopped. Check the private connection and Firebase configuration.",
        }),
      ),
    ),
  ),
);
