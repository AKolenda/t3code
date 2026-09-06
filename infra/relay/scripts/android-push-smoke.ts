// @effect-diagnostics nodeBuiltinImport:off - This developer command reads local credential files.
import * as NodeFSP from "node:fs/promises";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { RelayConfiguration } from "../src/Config.ts";
import { FcmClient, layer } from "../src/agentActivity/FcmClient.ts";

const Device = Schema.Struct({
  token: Schema.NonEmptyString,
  deviceId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  packageName: Schema.NonEmptyString,
  deepLink: Schema.optional(Schema.NonEmptyString),
});
const decodeDevice = Schema.decodeUnknownEffect(Schema.fromJsonString(Device));
const Phase = Schema.Literals(["running", "approval", "input", "completed", "failed", "end"]);
const decodePhase = Schema.decodeUnknownEffect(Phase);

class SmokeError extends Schema.TaggedErrorClass<SmokeError>()("SmokeError", {
  message: Schema.String,
}) {}

const main = Effect.gen(function* () {
  const [credentialPath, devicePath, phaseArg] = process.argv.slice(2);
  if (!credentialPath || !devicePath || !phaseArg)
    return yield* new SmokeError({
      message:
        "Usage: node scripts/android-push-smoke.ts <service-account.json> <device.json> <running|approval|input|completed|failed|end>",
    });
  const phase = yield* decodePhase(phaseArg);
  const credentials = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(credentialPath, "utf8"),
    catch: () => new SmokeError({ message: "Could not read service-account file." }),
  });
  const device = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(devicePath, "utf8"),
    catch: () => new SmokeError({ message: "Could not read device file." }),
  }).pipe(Effect.flatMap(decodeDevice));
  const title =
    phase === "completed"
      ? "Agent finished"
      : phase === "failed"
        ? "Agent failed"
        : phase === "approval"
          ? "Approval needed"
          : phase === "input"
            ? "Input needed"
            : null;
  const active = phase === "running" || phase === "approval" || phase === "input";
  const now = yield* Clock.currentTimeMillis;
  const config: RelayConfiguration["Service"] = {
    relayIssuer: "http://localhost",
    fcmServiceAccount: Redacted.make(credentials),
    apns: null,
    clerkSecretKey: Redacted.make(""),
    clerkPublishableKey: "",
    clerkJwtAudience: "",
    apnsDeliveryJobSigningSecret: Redacted.make(""),
    cloudMintPrivateKey: Redacted.make(""),
    cloudMintPublicKey: "",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
  };
  const result = yield* FcmClient.pipe(
    Effect.flatMap((client) =>
      client.send({
        token: device.token,
        packageName: device.packageName,
        alert: title !== null,
        data: {
          t3_kind: "agent_activity",
          device_id: device.deviceId,
          user_id: device.userId,
          updated_at: String(now),
          active: String(active),
          activity_title: active
            ? "1 active agent"
            : phase === "failed"
              ? "Agent work failed"
              : "Agent work completed",
          activity_expires_at: String(
            phase === "end" ? 0 : now + (active ? 2 * 60 * 60 * 1000 : 15 * 60 * 1000),
          ),
          activity_body: "Android notification test",
          activity_path: device.deepLink ?? "/",
          ...(title
            ? {
                alert_id: `smoke-${now}`,
                alert_title: title,
                alert_body: "T3 Code Android push test",
                alert_path: device.deepLink ?? "/",
              }
            : {}),
        },
      }),
    ),
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mergeAll(Layer.succeed(RelayConfiguration, config), FetchHttpClient.layer),
        ),
      ),
    ),
  );
  if (result.unregistered)
    return yield* new SmokeError({
      message: "This device token is no longer registered with Firebase.",
    });
  yield* Effect.logInfo(
    `Firebase accepted the ${phase} notification. Verify delivery on the device.`,
  );
});

NodeRuntime.runMain(main);
