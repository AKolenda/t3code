import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { RelayConfiguration } from "../Config.ts";

const FCM_HTTP_STAGE_TIMEOUT = "10 seconds";

const ServiceAccount = Schema.Struct({
  project_id: Schema.NonEmptyString,
  client_email: Schema.NonEmptyString,
  private_key: Schema.NonEmptyString,
});
const decodeServiceAccount = Schema.decodeUnknownOption(Schema.fromJsonString(ServiceAccount));
const decodeAccessToken = Schema.decodeUnknownEffect(
  Schema.Struct({ access_token: Schema.NonEmptyString }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFcmError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({
      status: Schema.optional(Schema.String),
      details: Schema.optional(
        Schema.Array(
          Schema.Struct({
            "@type": Schema.optional(Schema.String),
            errorCode: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  }),
);

export class FcmClientError extends Schema.TaggedErrorClass<FcmClientError>()("FcmClientError", {
  operation: Schema.Literals(["configuration", "authorize", "send"]),
  status: Schema.NullOr(Schema.Number),
}) {
  override get message() {
    return `FCM ${this.operation} failed${this.status === null ? "" : ` (${this.status})`}.`;
  }
}

export class FcmClient extends Context.Service<
  FcmClient,
  {
    readonly send: (input: {
      readonly token: string;
      readonly packageName: string | null;
      readonly data: Readonly<Record<string, string>>;
      readonly alert: boolean;
    }) => Effect.Effect<{ readonly unregistered: boolean }, FcmClientError>;
  }
>()("t3code-relay/agentActivity/FcmClient") {}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export const makeFcmAssertion = Effect.fn("relay.fcm.assertion")(function* (
  account: typeof ServiceAccount.Type,
  issuedAt: number,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder();
      const header = base64Url(encoder.encode(encodeJson({ alg: "RS256", typ: "JWT" })));
      const claims = base64Url(
        encoder.encode(
          encodeJson({
            iss: account.client_email,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: "https://oauth2.googleapis.com/token",
            iat: issuedAt,
            exp: issuedAt + 3600,
          }),
        ),
      );
      const pem = account.private_key.replace(/-----[^-]+-----|\s/g, "");
      const key = await crypto.subtle.importKey(
        "pkcs8",
        Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        encoder.encode(`${header}.${claims}`),
      );
      return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
    },
    catch: () => new FcmClientError({ operation: "authorize", status: null }),
  });
});

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration;
  const client = yield* HttpClient.HttpClient;
  const account = config.fcmServiceAccount
    ? decodeServiceAccount(Redacted.value(config.fcmServiceAccount))
    : Option.none();
  const authorize = Effect.gen(function* () {
    if (Option.isNone(account))
      return yield* new FcmClientError({ operation: "configuration", status: null });
    const now = yield* DateTime.now;
    const assertion = yield* makeFcmAssertion(
      account.value,
      Math.floor(now.epochMilliseconds / 1000),
    );
    const response = yield* client
      .execute(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
        ),
      )
      .pipe(
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.mapError(() => new FcmClientError({ operation: "authorize", status: null })),
      );
    if (response.status !== 200)
      return yield* new FcmClientError({ operation: "authorize", status: response.status });
    return yield* response.json.pipe(
      Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
      Effect.flatMap(decodeAccessToken),
      Effect.map((body) => body.access_token),
      Effect.mapError(
        () => new FcmClientError({ operation: "authorize", status: response.status }),
      ),
    );
  });
  const [accessToken, invalidateToken] = yield* Effect.cachedInvalidateWithTTL(
    authorize,
    "50 minutes",
  );

  return FcmClient.of({
    send: Effect.fn("relay.fcm.send")(function* (input) {
      if (new TextEncoder().encode(encodeJson(input.data)).length > 4096)
        return yield* new FcmClientError({ operation: "send", status: null });
      if (Option.isNone(account))
        return yield* new FcmClientError({ operation: "configuration", status: null });
      const token = yield* accessToken.pipe(Effect.tapError(() => invalidateToken));
      const response = yield* HttpClientRequest.post(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.value.project_id)}/messages:send`,
      ).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJson({
          message: {
            token: input.token,
            data: input.data,
            android: {
              priority: "HIGH",
              ttl: "300s",
              ...(!input.alert ? { collapse_key: "t3-agent-activity" } : {}),
              ...(input.packageName ? { restricted_package_name: input.packageName } : {}),
            },
          },
        }),
        Effect.flatMap(client.execute),
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.mapError(() => new FcmClientError({ operation: "send", status: null })),
      );
      if (response.status >= 200 && response.status < 300) return { unregistered: false };
      if (response.status === 401) yield* invalidateToken;
      const body = yield* response.json.pipe(
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.orElseSucceed(() => null),
      );
      const decoded = decodeFcmError(body);
      const unregistered =
        Option.isSome(decoded) &&
        decoded.value.error.details?.some(
          (detail) =>
            detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
            detail.errorCode === "UNREGISTERED",
        ) === true;
      if (unregistered) return { unregistered: true };
      return yield* new FcmClientError({ operation: "send", status: response.status });
    }),
  });
});

export const layer = Layer.effect(FcmClient, make);
