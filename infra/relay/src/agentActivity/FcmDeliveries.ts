import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { and, eq } from "drizzle-orm";
import {
  RelayAgentActivityState,
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
  type RelayDeliveryResult,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import { relayMobileDevices } from "../persistence/schema.ts";
import { EnvironmentLinks } from "../environments/EnvironmentLinks.ts";
import { AgentActivityRows } from "./AgentActivityRows.ts";
import { LiveActivities, type TargetRow } from "./LiveActivities.ts";
import { FcmClient } from "./FcmClient.ts";
import { androidActivityData, androidActivityHero, fitFcmData } from "./fcmPayloads.ts";
import { makeAggregateState, statusForPhase } from "./agentActivityAggregate.ts";
import { isExpiredAgentActivityState, notificationForActivity } from "./agentActivityPayloads.ts";
import {
  alertForActivityRows,
  attentionTransitionRows,
  terminalTransitionRows,
  isFreshTerminalNotification,
} from "./agentActivityAlerts.ts";

export const FcmDeliveryJob = Schema.Struct({
  userId: Schema.String,
  deviceId: Schema.String,
  token: Schema.String,
  state: Schema.NullOr(RelayAgentActivityState),
  queuedAt: Schema.Number,
});
export type FcmDeliveryJob = typeof FcmDeliveryJob.Type;
const decodeJob = Schema.decodeUnknownEffect(FcmDeliveryJob);
const decodePreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferences),
);
const decodePreviousActivity = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityAggregateState),
);

export class FcmDeliveryError extends Schema.TaggedErrorClass<FcmDeliveryError>()(
  "FcmDeliveryError",
  {
    operation: Schema.Literals(["enqueue", "process"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to ${this.operation} Android notification delivery.`;
  }
}

export class FcmDeliveryQueueSender extends Context.Service<
  FcmDeliveryQueueSender,
  {
    readonly send: (body: FcmDeliveryJob) => Effect.Effect<void, Cloudflare.Queues.SendError>;
  }
>()("t3code-relay/agentActivity/FcmDeliveries/FcmDeliveryQueueSender") {}

export class FcmDeliveries extends Context.Service<
  FcmDeliveries,
  {
    readonly enqueue: (input: {
      readonly target: TargetRow;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<RelayDeliveryResult | null, FcmDeliveryError>;
    readonly process: (body: unknown) => Effect.Effect<void, FcmDeliveryError>;
  }
>()("t3code-relay/agentActivity/FcmDeliveries") {}

export function androidAlertForState(
  state: RelayAgentActivityState,
  preferences: RelayAgentAwarenessPreferences,
  nowMs: number,
) {
  if (!preferences.notificationsEnabled) return null;
  if (
    (state.phase === "completed" || state.phase === "failed") &&
    !isFreshTerminalNotification(state.updatedAt, nowMs)
  )
    return null;
  const enabled =
    (state.phase === "waiting_for_approval" && preferences.notifyOnApproval) ||
    (state.phase === "waiting_for_input" && preferences.notifyOnInput) ||
    (state.phase === "completed" && preferences.notifyOnCompletion) ||
    (state.phase === "failed" && preferences.notifyOnFailure);
  if (!enabled) return null;
  const notification = notificationForActivity({ ...state, status: statusForPhase(state.phase) });
  return {
    alert_id: JSON.stringify([state.environmentId, state.threadId, state.phase, state.updatedAt]),
    alert_title: notification.title,
    alert_body: notification.body,
    alert_path: notification.deepLink,
  };
}

export function androidAlertForAggregate(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly nowMs: number;
}) {
  if (!input.preferences.notificationsEnabled) return null;
  const attention = attentionTransitionRows(input);
  const activities = attention.length > 0 ? attention : terminalTransitionRows(input);
  const first = activities[0];
  const alert = alertForActivityRows(activities);
  if (!first || !alert) return null;
  if (activities.length === 1) {
    const notification = notificationForActivity(first);
    return {
      alert_id: JSON.stringify([first.environmentId, first.threadId, first.phase, first.updatedAt]),
      alert_title: notification.title,
      alert_body: notification.body,
      alert_path: notification.deepLink,
    };
  }
  return {
    // Every contributing queue job identifies the same group, including after
    // retries or a different database row order. The native handler deduplicates it.
    alert_id: JSON.stringify(
      activities
        .map((row) => [row.environmentId, row.threadId, row.phase, row.updatedAt])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ),
    alert_title: alert.title,
    alert_body: alert.body,
    alert_path: androidActivityHero(input.nextAggregate)?.deepLink ?? "/",
  };
}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration;
  const sender = yield* FcmDeliveryQueueSender;
  const client = yield* FcmClient;
  const devices = yield* LiveActivities;
  const rows = yield* AgentActivityRows;
  const links = yield* EnvironmentLinks;
  const db = yield* RelayDb;

  return FcmDeliveries.of({
    enqueue: Effect.fn("relay.fcm.enqueue")(function* (input) {
      if (input.target.platform !== "android" || !input.target.push_token) return null;
      if (!config.fcmServiceAccount) {
        yield* Effect.logWarning("Android notifications are not configured for this relay");
        return {
          deviceId: input.target.device_id,
          kind: "push_notification",
          ok: false,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
        };
      }
      const now = yield* DateTime.now;
      yield* sender
        .send({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          token: input.target.push_token,
          state: input.state,
          queuedAt: now.epochMilliseconds,
        })
        .pipe(Effect.mapError((cause) => new FcmDeliveryError({ operation: "enqueue", cause })));
      return {
        deviceId: input.target.device_id,
        kind: "push_notification",
        ok: true,
        queued: true,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
      };
    }),
    process: Effect.fn("relay.fcm.process")(
      function* (body) {
        const job = yield* decodeJob(body);
        const now = yield* DateTime.now;
        if (now.epochMilliseconds - job.queuedAt > 5 * 60_000) return;
        const targets = yield* devices.listTargets({ userId: job.userId });
        const target = targets.find(
          (device) =>
            device.device_id === job.deviceId &&
            device.platform === "android" &&
            device.push_token === job.token,
        );
        if (!target) return;
        const preferences = decodePreferences(target.preferences_json);
        if (Option.isNone(preferences)) return;

        // Re-read links and state when consuming: queued messages must honor
        // sign-out, token rotation, disabled publishing, and newer thread states.
        const states = preferences.value.liveActivitiesEnabled
          ? yield* rows.listForUser({ userId: job.userId })
          : [];
        const aggregate = makeAggregateState({
          activeStates: states,
          terminalState: null,
          nowMs: now.epochMilliseconds,
        });
        const previousAggregate = target.last_aggregate_json
          ? Option.getOrNull(decodePreviousActivity(target.last_aggregate_json))
          : null;
        let alert: ReturnType<typeof androidAlertForState> = null;
        if (job.state && preferences.value.notificationsEnabled) {
          const state = yield* rows.getForUserThread({
            userId: job.userId,
            environmentId: job.state.environmentId,
            threadId: job.state.threadId,
          });
          if (
            !previousAggregate &&
            (!state || state.phase !== job.state.phase || state.updatedAt !== job.state.updatedAt)
          )
            return;
          const link = yield* links.getForUser({
            userId: job.userId,
            environmentId: job.state.environmentId,
          });
          const deliveryUsers = link
            ? yield* links.listDeliveryUsersForEnvironment({
                environmentId: job.state.environmentId,
                environmentPublicKey: link.environmentPublicKey,
              })
            : [];
          const deliveryUser = deliveryUsers.find((user) => user.userId === job.userId);
          if (
            deliveryUser?.notificationsEnabled &&
            deliveryUser.liveActivitiesEnabled &&
            preferences.value.liveActivitiesEnabled &&
            previousAggregate &&
            aggregate
          ) {
            const environmentIds = [
              ...new Set(aggregate.activities.map((row) => row.environmentId)),
            ];
            const allowedEnvironments = new Set<string>();
            for (const environmentId of environmentIds) {
              if (environmentId === job.state.environmentId) {
                allowedEnvironments.add(environmentId);
                continue;
              }
              const environmentLink = yield* links.getForUser({
                userId: job.userId,
                environmentId,
              });
              if (!environmentLink) continue;
              const users = yield* links.listDeliveryUsersForEnvironment({
                environmentId,
                environmentPublicKey: environmentLink.environmentPublicKey,
              });
              if (users.some((user) => user.userId === job.userId && user.notificationsEnabled)) {
                allowedEnvironments.add(environmentId);
              }
            }
            alert = androidAlertForAggregate({
              previousAggregate,
              nextAggregate: {
                ...aggregate,
                activities: aggregate.activities.filter((row) =>
                  allowedEnvironments.has(row.environmentId),
                ),
              },
              preferences: preferences.value,
              nowMs: now.epochMilliseconds,
            });
          } else if (
            deliveryUser?.notificationsEnabled &&
            state?.phase === job.state.phase &&
            state.updatedAt === job.state.updatedAt &&
            !isExpiredAgentActivityState(state, now.epochMilliseconds)
          ) {
            alert = androidAlertForState(state, preferences.value, now.epochMilliseconds);
          }
        }
        const displayedAggregate =
          preferences.value.notificationsEnabled && preferences.value.liveActivitiesEnabled
            ? aggregate
            : null;
        const active = (displayedAggregate?.activeCount ?? 0) > 0;
        // A registration replay must clear an orphan even when the relay has
        // already forgotten its baseline. Finished cards are visible, but idle.
        if (!displayedAggregate && !alert && !previousAggregate && job.state !== null) return;
        const data = {
          t3_kind: "agent_activity",
          device_id: job.deviceId,
          user_id: job.userId,
          updated_at: String(now.epochMilliseconds),
          ...androidActivityData(displayedAggregate),
          ...alert,
        };
        if (alert) {
          // Group identities can contain five sets of IDs. Hash the full,
          // stable identity rather than spending the payload budget on it.
          const digest = yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(alert.alert_id)),
          );
          data.alert_id = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        }
        const result = yield* client.send({
          token: job.token,
          packageName: target.bundle_id,
          alert: alert !== null,
          data: fitFcmData(data),
        });
        if (result.unregistered) {
          yield* db
            .update(relayMobileDevices)
            .set({ pushToken: null })
            .where(
              and(
                eq(relayMobileDevices.userId, job.userId),
                eq(relayMobileDevices.deviceId, job.deviceId),
                eq(relayMobileDevices.pushToken, job.token),
              ),
            );
        } else {
          yield* devices.markDelivery({
            userId: job.userId,
            deviceId: job.deviceId,
            kind: active ? "live_activity_update" : "live_activity_end",
            // Keep the delivered terminal rows as the next transition baseline,
            // so replaying the finished card cannot alert again.
            aggregate: preferences.value.liveActivitiesEnabled ? aggregate : null,
            deliveredAt: DateTime.formatIso(now),
          });
        }
      },
      Effect.mapError((cause) => new FcmDeliveryError({ operation: "process", cause })),
    ),
  });
});

export const layer = Layer.effect(FcmDeliveries, make);
export const layerCloudflareQueues = (
  sender: Cloudflare.Queues.WriteQueueClient,
  runtime: Alchemy.BaseRuntimeContext,
) =>
  layer.pipe(
    Layer.provide(
      Layer.succeed(FcmDeliveryQueueSender, {
        send: (body) =>
          sender.send(body).pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
      }),
    ),
  );
