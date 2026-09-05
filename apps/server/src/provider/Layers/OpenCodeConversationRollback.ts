import {
  NonNegativeInt,
  type OpenCodeSettings,
  ProviderInstanceId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { OpenCodeRuntime, OpenCodeRuntimeError, runOpenCodeSdk } from "../opencodeRuntime.ts";

const SessionIdentity = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectID: TrimmedNonEmptyString,
  directory: TrimmedNonEmptyString,
  time: Schema.Struct({ created: NonNegativeInt }),
  revert: Schema.optionalKey(
    Schema.Struct({
      messageID: TrimmedNonEmptyString,
      partID: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});

// Keep every content field. The fork rewrites only these top-level identities
// and the two message references normalized below.
const Message = Schema.Struct({
  info: Schema.StructWithRest(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      sessionID: TrimmedNonEmptyString,
      role: Schema.Literals(["user", "assistant"]),
      parentID: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  parts: Schema.Array(
    Schema.StructWithRest(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        messageID: TrimmedNonEmptyString,
        sessionID: TrimmedNonEmptyString,
        type: TrimmedNonEmptyString,
        tail_start_id: Schema.optionalKey(TrimmedNonEmptyString),
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
});

const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: TrimmedNonEmptyString,
});

const RollbackTarget = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  instanceId: ProviderInstanceId,
  directory: TrimmedNonEmptyString,
  source: SessionIdentity,
  cutoffMessageId: Schema.NullOr(TrimmedNonEmptyString),
  sourceDigest: TrimmedNonEmptyString,
  prefixDigest: TrimmedNonEmptyString,
});

const rollbackError = (detail: string, cause?: unknown) =>
  new ProviderAdapterRequestError({
    provider: "opencode",
    method: "conversationRollback",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const toRequestError = (cause: OpenCodeRuntimeError | ProviderAdapterRequestError) =>
  OpenCodeRuntimeError.is(cause) ? rollbackError(cause.detail, cause) : cause;

const decodeSession = Schema.decodeUnknownEffect(SessionIdentity);
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(Message));
const decodeResumeCursor = Schema.decodeUnknownEffect(ResumeCursor);
const decodeTarget = Schema.decodeUnknownEffect(RollbackTarget);
const decodeNumTurns = Schema.decodeUnknownEffect(NonNegativeInt);

const readConversation = Effect.fn("OpenCodeConversationRollback.readConversation")(function* (
  client: OpencodeClient,
  sessionId: string,
) {
  const response = yield* runOpenCodeSdk("session.get", (signal) =>
    client.session.get({ sessionID: sessionId }, { signal }),
  );
  const session = yield* decodeSession(response.data).pipe(
    Effect.mapError((cause) => rollbackError("OpenCode returned invalid session metadata.", cause)),
  );
  if (session.id !== sessionId || session.revert?.partID !== undefined) {
    return yield* rollbackError(
      "OpenCode rewind requires the original session with a full-message history boundary.",
    );
  }
  const messageResponse = yield* runOpenCodeSdk("session.messages", (signal) =>
    client.session.messages({ sessionID: sessionId }, { signal }),
  );
  const messages = yield* decodeMessages(messageResponse.data).pipe(
    Effect.mapError((cause) =>
      rollbackError("OpenCode returned invalid conversation history.", cause),
    ),
  );
  const messageIds = new Set<string>();
  const partIds = new Set<string>();
  for (const message of messages) {
    if (message.info.sessionID !== sessionId || messageIds.has(message.info.id)) {
      return yield* rollbackError("OpenCode returned inconsistent message identities.");
    }
    messageIds.add(message.info.id);
    for (const part of message.parts) {
      if (
        part.sessionID !== sessionId ||
        part.messageID !== message.info.id ||
        partIds.has(part.id)
      ) {
        return yield* rollbackError("OpenCode returned inconsistent part identities.");
      }
      partIds.add(part.id);
    }
  }
  const visibleLength = session.revert
    ? messages.findIndex((message) => message.info.id === session.revert?.messageID)
    : messages.length;
  if (visibleLength < 0) {
    return yield* rollbackError(
      "OpenCode's saved history boundary is missing from the conversation.",
    );
  }
  return { session, messages, visibleLength };
});

const normalizePrefix = Effect.fn("OpenCodeConversationRollback.normalizePrefix")(function* (
  messages: ReadonlyArray<typeof Message.Type>,
) {
  const messageIndexes = new Map<string, number>();
  const normalized = [];
  for (const [index, message] of messages.entries()) {
    messageIndexes.set(message.info.id, index);
    const reference = (id: string | undefined) =>
      id === undefined ? undefined : (messageIndexes.get(id) ?? id);
    const { id: _messageId, sessionID: _sessionId, ...info } = message.info;
    const parts = [];
    for (const part of message.parts) {
      if (
        part.type === "compaction" &&
        part.tail_start_id !== undefined &&
        !messageIndexes.has(part.tail_start_id)
      ) {
        return yield* rollbackError("OpenCode cannot preserve this compaction history boundary.");
      }
      const {
        id: _partId,
        sessionID: _partSessionId,
        messageID: _partMessageId,
        ...content
      } = part;
      parts.push(
        part.type === "compaction"
          ? { ...content, tail_start_id: reference(part.tail_start_id) }
          : content,
      );
    }
    normalized.push({
      info: info.role === "assistant" ? { ...info, parentID: reference(info.parentID) } : info,
      parts,
    });
  }
  return normalized;
});

/** Prepare and copy native history without adopting or changing the source session. */
export const makeOpenCodeConversationRollback = Effect.fn("makeOpenCodeConversationRollback")(
  function* (options: {
    readonly settings: OpenCodeSettings;
    readonly instanceId: ProviderInstanceId;
    readonly defaultDirectory: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly sameDirectory: (left: string, right: string) => Effect.Effect<boolean>;
  }) {
    const runtime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const connect = Effect.fn("OpenCodeConversationRollback.connect")(function* (
      directory: string,
    ) {
      const server = yield* runtime.connectToOpenCodeServer({
        binaryPath: options.settings.binaryPath,
        directory,
        serverUrl: options.settings.serverUrl,
        ...(options.settings.serverPassword
          ? { serverPassword: options.settings.serverPassword }
          : {}),
        ...(options.environment ? { environment: options.environment } : {}),
      });
      return runtime.createOpenCodeSdkClient({
        baseUrl: server.url,
        directory,
        ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
      });
    });
    const digest = Effect.fn("OpenCodeConversationRollback.digest")(function* (content: unknown) {
      const hash = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(stableStringify(content)))
        .pipe(
          Effect.mapError((cause) => rollbackError("Could not verify OpenCode history.", cause)),
        );
      return Encoding.encodeHex(hash);
    });

    const prepare: NonNullable<OpenCodeAdapterShape["conversationRollback"]>["prepare"] = Effect.fn(
      "OpenCodeConversationRollback.prepare",
    )(
      function* (input) {
        const cursor = yield* decodeResumeCursor(input.resumeCursor).pipe(
          Effect.mapError((cause) =>
            rollbackError("OpenCode rewind requires the original saved session cursor.", cause),
          ),
        );
        const numTurns = yield* decodeNumTurns(input.numTurns).pipe(
          Effect.mapError((cause) =>
            rollbackError("OpenCode rewind requires a valid turn count.", cause),
          ),
        );
        const directory = input.cwd ?? options.defaultDirectory;
        const client = yield* connect(directory);
        const source = yield* readConversation(client, cursor.sessionId);
        const visible = source.messages.slice(0, source.visibleLength);
        let cutoffIndex = visible.length;
        if (numTurns > 0) {
          const assistantIndexes = visible.flatMap((message, index) =>
            message.info.role === "assistant" ? [index] : [],
          );
          cutoffIndex = assistantIndexes[Math.max(0, assistantIndexes.length - numTurns)] ?? 0;
          // Native revert removes the preceding user prompt and every assistant
          // step after it, even when several steps share that prompt.
          for (let index = cutoffIndex; index >= 0; index -= 1) {
            if (visible[index]?.info.role === "user") {
              cutoffIndex = index;
              break;
            }
          }
        }
        const prefix = source.messages.slice(0, cutoffIndex);
        return {
          schemaVersion: 1,
          instanceId: options.instanceId,
          directory,
          source: source.session,
          cutoffMessageId: source.messages[cutoffIndex]?.info.id ?? null,
          sourceDigest: yield* digest(source.messages),
          prefixDigest: yield* digest(yield* normalizePrefix(prefix)),
        } satisfies typeof RollbackTarget.Type;
      },
      Effect.scoped,
      Effect.mapError(toRequestError),
    );

    const fork: NonNullable<OpenCodeAdapterShape["conversationRollback"]>["fork"] = Effect.fn(
      "OpenCodeConversationRollback.fork",
    )(
      function* (rawTarget) {
        const target = yield* decodeTarget(rawTarget).pipe(
          Effect.mapError((cause) => rollbackError("Invalid saved OpenCode rewind target.", cause)),
        );
        if (target.instanceId !== options.instanceId) {
          return yield* rollbackError(
            "The OpenCode rewind target belongs to another provider instance.",
          );
        }
        const client = yield* connect(target.directory);
        const source = yield* readConversation(client, target.source.id);
        if (
          stableStringify(source.session) !== stableStringify(target.source) ||
          (yield* digest(source.messages)) !== target.sourceDigest
        ) {
          return yield* rollbackError(
            "The original OpenCode conversation changed after rewind was prepared.",
          );
        }
        const cutoffIndex =
          target.cutoffMessageId === null
            ? source.messages.length
            : source.messages.findIndex((message) => message.info.id === target.cutoffMessageId);
        if (cutoffIndex < 0 || cutoffIndex > source.visibleLength) {
          return yield* rollbackError("The saved OpenCode rewind boundary is no longer available.");
        }
        const prefix = source.messages.slice(0, cutoffIndex);
        if ((yield* digest(yield* normalizePrefix(prefix))) !== target.prefixDigest) {
          return yield* rollbackError(
            "The saved OpenCode rewind prefix does not match its boundary.",
          );
        }
        if (prefix.length === 0) {
          return null;
        }
        const forked = yield* runOpenCodeSdk("session.fork", (signal) =>
          client.session.fork(
            {
              sessionID: target.source.id,
              directory: target.directory,
              ...(target.cutoffMessageId === null ? {} : { messageID: target.cutoffMessageId }),
            },
            { signal },
          ),
        );
        const forkedSession = yield* decodeSession(forked.data).pipe(
          Effect.mapError((cause) =>
            rollbackError("OpenCode returned an invalid history copy.", cause),
          ),
        );
        if (forkedSession.id === target.source.id) {
          return yield* rollbackError(
            "OpenCode did not create a separate conversation for rewind.",
          );
        }
        const copy = yield* readConversation(client, forkedSession.id);
        if (
          copy.session.revert !== undefined ||
          !(yield* options.sameDirectory(copy.session.directory, target.directory)) ||
          (yield* digest(yield* normalizePrefix(copy.messages))) !== target.prefixDigest
        ) {
          return yield* rollbackError(
            "The OpenCode history copy does not match the saved rewind prefix.",
          );
        }
        const original = yield* readConversation(client, target.source.id);
        if (
          stableStringify(original.session) !== stableStringify(target.source) ||
          (yield* digest(original.messages)) !== target.sourceDigest
        ) {
          return yield* rollbackError(
            "The original OpenCode conversation changed while it was copied.",
          );
        }
        return { schemaVersion: 1, sessionId: copy.session.id } satisfies typeof ResumeCursor.Type;
      },
      Effect.scoped,
      Effect.mapError(toRequestError),
    );

    return { prepare, fork };
  },
);
