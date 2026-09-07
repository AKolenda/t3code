/** Read native Cursor and OpenCode history without starting either provider. */
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import type { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AgentSessionThread, AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_MESSAGES = 200;

export interface DatabaseReadBudget {
  bytesRemaining: number;
  recordsRemaining: number;
}
const newReadBudget = (): DatabaseReadBudget => ({
  bytesRemaining: MAX_HISTORY_BYTES,
  recordsRemaining: MAX_RECORDS,
});

export interface DatabaseSession {
  readonly format?: "cursor-desktop";
  readonly filePath: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly updatedAtMs: number;
}

const CursorMeta = Schema.Struct({
  agentId: Schema.String,
  latestRootBlobId: Schema.String,
  name: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  lastUsedModel: Schema.optional(Schema.String),
  subagentInfo: Schema.optional(Schema.Unknown),
});
const OpenCodeSession = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  title: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
});
const TextPart = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
});
const ModelRef = Schema.Struct({
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
const OpenCodeMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(TextPart)),
  model: Schema.optional(ModelRef),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
});
const decodeCursorMeta = Schema.decodeUnknownSync(Schema.fromJsonString(CursorMeta));
const decodeOpenCodeSession = Schema.decodeUnknownSync(OpenCodeSession);
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(OpenCodeMessage));
const decodePart = Schema.decodeUnknownOption(Schema.fromJsonString(TextPart));

/** A read transaction also gives WAL-backed stores a consistent snapshot. */
function withDatabase<A>(filePath: string, read: (db: NodeSqlite.DatabaseSync) => A): A {
  const db = new NodeSqlite.DatabaseSync(filePath, { readOnly: true, timeout: 100 });
  try {
    db.exec("BEGIN");
    return read(db);
  } finally {
    db.close();
  }
}

/** Only length-delimited protobuf fields are needed from Cursor's conversation graph. */
function protobufFields(bytes: Uint8Array): Map<number, Array<Uint8Array>> {
  let offset = 0;
  const fields = new Map<number, Array<Uint8Array>>();
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 56 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if ((byte & 128) === 0) return value;
    }
    throw new Error("Invalid Cursor protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    const wire = tag % 8;
    if (wire === 0) {
      varint();
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
    } else if (wire === 2) {
      const length = varint();
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
        throw new Error("Invalid Cursor protobuf length");
      }
      const field = Math.floor(tag / 8);
      const values = fields.get(field) ?? [];
      values.push(bytes.subarray(offset, offset + length));
      fields.set(field, values);
      offset += length;
    } else {
      throw new Error("Unsupported Cursor protobuf wire type");
    }
    if (offset > bytes.length) throw new Error("Truncated Cursor protobuf");
  }
  return fields;
}

function cursorReader(db: NodeSqlite.DatabaseSync, budget: DatabaseReadBudget) {
  const query = db.prepare("SELECT data FROM blobs WHERE id = ? AND length(data) <= ?");
  return (id: string | Uint8Array): Uint8Array => {
    if (--budget.recordsRemaining < 0) throw new Error("Cursor history record limit");
    const row = query.get(
      typeof id === "string" ? id : Buffer.from(id).toString("hex"),
      budget.bytesRemaining,
    );
    if (!(row?.data instanceof Uint8Array)) throw new Error("Missing or oversized Cursor blob");
    budget.bytesRemaining -= row.data.byteLength;
    return row.data;
  };
}

function readCursorMetadata(db: NodeSqlite.DatabaseSync) {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = '0' AND length(value) <= ?")
    .get(MAX_METADATA_BYTES);
  if (typeof row?.value !== "string") return null;
  const meta = decodeCursorMeta(Buffer.from(row.value, "hex").toString("utf8"));
  if (meta.subagentInfo != null || !meta.agentId.trim() || !meta.latestRootBlobId) return null;
  const read = cursorReader(db, {
    bytesRemaining: MAX_METADATA_BYTES,
    recordsRemaining: MAX_RECORDS,
  });
  const root = protobufFields(read(meta.latestRootBlobId));
  const workspace = root.get(9)?.[0];
  if (workspace === undefined) return null;
  const cwd = NodeURL.fileURLToPath(Buffer.from(workspace).toString("utf8"));
  return { meta, root, cwd };
}

export function discoverCursorSession(
  filePath: string,
  updatedAtMs: number,
): DatabaseSession | null {
  return withDatabase(filePath, (db) => {
    const metadata = readCursorMetadata(db);
    return metadata === null
      ? null
      : {
          filePath,
          sessionId: metadata.meta.agentId,
          cwd: metadata.cwd,
          updatedAtMs,
        };
  });
}

const DesktopUri = Schema.Struct({
  scheme: Schema.optional(Schema.String),
  fsPath: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});
const DesktopHeader = Schema.Struct({
  composerId: Schema.String,
  name: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  lastUpdatedAt: Schema.optional(Schema.Number),
  workspaceIdentifier: Schema.optional(Schema.Struct({ uri: Schema.optional(DesktopUri) })),
  trackedGitRepos: Schema.optional(Schema.Array(Schema.Struct({ repoPath: Schema.String }))),
});
const DesktopBubble = Schema.Struct({
  bubbleId: Schema.String,
  type: Schema.Number,
  text: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  isThought: Schema.optional(Schema.Boolean),
  isSummary: Schema.optional(Schema.Boolean),
  grouping: Schema.optional(Schema.Struct({ isSimulatedMsg: Schema.optional(Schema.Boolean) })),
});
const DesktopComposer = Schema.Struct({
  ...DesktopHeader.fields,
  subagentInfo: Schema.optional(Schema.Unknown),
  isBestOfNSubcomposer: Schema.optional(Schema.Boolean),
  modelConfig: Schema.optional(Schema.Struct({ modelName: Schema.optional(Schema.String) })),
  fullConversationHeadersOnly: Schema.optional(Schema.Array(DesktopBubble)),
  conversation: Schema.optional(Schema.Array(DesktopBubble)),
});
const decodeDesktopComposer = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopComposer));
const decodeDesktopHeader = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopHeader));
const decodeDesktopHeaderValue = Schema.decodeUnknownSync(DesktopHeader);
const decodeDesktopMetadataRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeDesktopIndex = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ allComposers: Schema.Array(DesktopHeader) })),
);
const decodeDesktopBubble = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBubble));

/** Older Cursor versions index project ownership in each workspace database. */
export function readCursorDesktopWorkspaceIndex(filePath: string): ReadonlyArray<string> {
  return withDatabase(filePath, (db) => {
    const row = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key = 'composer.composerData' AND length(value) <= ?",
      )
      .get(MAX_METADATA_BYTES);
    if (typeof row?.value !== "string") return [];
    const index = decodeDesktopIndex(row.value);
    return index.allComposers.map((composer) => composer.composerId);
  });
}

function desktopCwd(header: typeof DesktopHeader.Type): string | undefined {
  const uri = header.workspaceIdentifier?.uri;
  if (uri?.scheme === "file") return uri.fsPath ?? uri.path;
  // Never map a remote workspace URI onto an unrelated local checkout.
  if (uri !== undefined) return undefined;
  return header.trackedGitRepos?.length === 1 ? header.trackedGitRepos[0]?.repoPath : undefined;
}

function desktopMetadata(db: NodeSqlite.DatabaseSync, id: string, fallbackCwd?: string) {
  // Project only metadata in SQL: composer values include large file snapshots.
  const row = db
    .prepare(`SELECT json_object(
    'composerId', json_extract(value, '$.composerId'),
    'name', coalesce(json_extract(value, '$.name'), ''),
    'createdAt', json_extract(value, '$.createdAt'),
    'lastUpdatedAt', coalesce(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt')),
    'workspaceIdentifier', json_extract(value, '$.workspaceIdentifier'),
    'trackedGitRepos', json_extract(value, '$.trackedGitRepos')
  ) AS metadata FROM cursorDiskKV WHERE key = ? AND json_valid(value)
    AND json_extract(value, '$.subagentInfo') IS NULL
    AND coalesce(json_extract(value, '$.isBestOfNSubcomposer'), 0) = 0
    AND (coalesce(json_array_length(value, '$.fullConversationHeadersOnly'), 0) > 0
      OR coalesce(json_array_length(value, '$.conversation'), 0) > 0)`)
    .get(`composerData:${id}`);
  if (typeof row?.metadata !== "string") return null;
  // JSON projection uses null for absent properties; strip them before decoding.
  const raw = decodeDesktopMetadataRecord(row.metadata);
  const metadata = decodeDesktopHeaderValue(
    Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null)),
  );
  let header = metadata;
  if (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'composerHeaders'")
      .get()
  ) {
    const row = db
      .prepare("SELECT value FROM composerHeaders WHERE composerId = ? AND length(value) <= ?")
      .get(id, MAX_METADATA_BYTES);
    if (typeof row?.value === "string") header = { ...metadata, ...decodeDesktopHeader(row.value) };
  }
  const cwd =
    desktopCwd(header) ?? (header.workspaceIdentifier?.uri === undefined ? fallbackCwd : undefined);
  const createdAtMs = metadata.createdAt;
  const updatedAtMs = header.lastUpdatedAt ?? createdAtMs;
  return cwd && createdAtMs !== undefined && updatedAtMs !== undefined
    ? { cwd, createdAtMs, updatedAtMs, title: header.name ?? metadata.name ?? "" }
    : null;
}

export function discoverCursorDesktopSessions(
  filePath: string,
  limit: number,
  roots: ReadonlyMap<string, string> = new Map(),
): Array<DatabaseSession> {
  return withDatabase(filePath, (db) => {
    const rows = db
      .prepare(
        `SELECT substr(key, 14) AS id FROM cursorDiskKV WHERE key GLOB 'composerData:*' AND json_valid(value)
          AND (coalesce(json_array_length(value, '$.fullConversationHeadersOnly'), 0) > 0 OR coalesce(json_array_length(value, '$.conversation'), 0) > 0)
          ORDER BY coalesce(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt')) DESC, key LIMIT ?`,
      )
      .all(limit);
    return rows.flatMap(({ id }) => {
      if (typeof id !== "string") return [];
      try {
        const metadata = desktopMetadata(db, id, roots.get(id));
        return metadata === null
          ? []
          : [
              {
                format: "cursor-desktop" as const,
                filePath,
                sessionId: id,
                cwd: metadata.cwd,
                updatedAtMs: metadata.updatedAtMs,
              },
            ];
      } catch {
        return [];
      }
    });
  });
}

export function readCursorDesktopThread(
  session: DatabaseSession,
  providerInstanceId: ProviderInstanceId,
  budget: DatabaseReadBudget = newReadBudget(),
) {
  return withDatabase(session.filePath, (db) => {
    const metadata = desktopMetadata(db, session.sessionId, session.cwd);
    if (metadata === null) return null;
    const row = db
      .prepare(`SELECT value FROM (SELECT json_object(
        'composerId', json_extract(value, '$.composerId'),
        'modelConfig', coalesce(json_extract(value, '$.modelConfig'), json('{}')),
        'fullConversationHeadersOnly', coalesce(json_extract(value, '$.fullConversationHeadersOnly'), json('[]')),
        'conversation', coalesce(json_extract(value, '$.conversation'), json('[]'))
      ) AS value FROM cursorDiskKV WHERE key = ?) WHERE length(value) <= ?`)
      .get(`composerData:${session.sessionId}`, budget.bytesRemaining);
    if (typeof row?.value !== "string") throw new Error("Missing or oversized Cursor composer");
    budget.bytesRemaining -= Buffer.byteLength(row.value);
    const composer = decodeDesktopComposer(row.value);
    const messages: Array<AgentSessionThreadMessage> = [];
    const append = (bubble: typeof DesktopBubble.Type) => {
      if (
        (bubble.type !== 1 && bubble.type !== 2) ||
        bubble.isThought ||
        bubble.isSummary ||
        !bubble.text?.trim()
      )
        return;
      const timestamp =
        bubble.createdAt === undefined ? metadata.createdAtMs : Date.parse(bubble.createdAt);
      messages.push({
        role: bubble.type === 1 ? "user" : "assistant",
        text: bubble.text.trim(),
        createdAt: iso(Number.isFinite(timestamp) ? timestamp : metadata.createdAtMs),
      });
    };
    const query = db.prepare(`SELECT value FROM (SELECT json_object(
      'bubbleId', json_extract(value, '$.bubbleId'),
      'type', json_extract(value, '$.type'),
      'text', coalesce(json_extract(value, '$.text'), ''),
      'createdAt', coalesce(json_extract(value, '$.createdAt'), '')
    ) AS value FROM cursorDiskKV WHERE key = ?) WHERE length(value) <= ?`);
    if (composer.fullConversationHeadersOnly?.length) {
      for (const header of composer.fullConversationHeadersOnly) {
        if (--budget.recordsRemaining < 0) throw new Error("Cursor history record limit");
        if ((header.type !== 1 && header.type !== 2) || header.grouping?.isSimulatedMsg) continue;
        const row = query.get(
          `bubbleId:${session.sessionId}:${header.bubbleId}`,
          budget.bytesRemaining,
        );
        if (typeof row?.value !== "string") throw new Error("Missing or oversized Cursor bubble");
        budget.bytesRemaining -= Buffer.byteLength(row.value);
        append(decodeDesktopBubble(row.value));
      }
    } else {
      for (const bubble of composer.conversation ?? []) {
        if (--budget.recordsRemaining < 0) throw new Error("Cursor history record limit");
        append(bubble);
      }
    }
    const thread = finishThread({
      source: "cursor",
      providerInstanceId,
      providerSessionId: session.sessionId,
      title: metadata.title,
      model: composer.modelConfig?.modelName ?? null,
      createdAtMs: metadata.createdAtMs,
      updatedAtMs: metadata.updatedAtMs,
      messages,
    });
    return thread === null ? null : { cwd: metadata.cwd, thread };
  });
}

export function discoverOpenCodeSessions(filePath: string, limit: number) {
  return withDatabase(filePath, (db) =>
    db
      .prepare(
        "SELECT id, directory, title, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC, id LIMIT ?",
      )
      .all(limit)
      .map((row): DatabaseSession => {
        const session = decodeOpenCodeSession(row);
        return {
          filePath,
          sessionId: session.id,
          cwd: session.directory,
          updatedAtMs: session.time_updated,
        };
      }),
  );
}

/** Recheck cached discovery before a retry can treat a session as completed. */
export function refreshDatabaseSession(session: DatabaseSession, source: "cursor" | "opencode") {
  if (session.format === "cursor-desktop")
    return withDatabase(session.filePath, (db) => {
      const metadata = desktopMetadata(db, session.sessionId, session.cwd);
      return metadata === null
        ? null
        : { ...session, cwd: metadata.cwd, updatedAtMs: metadata.updatedAtMs };
    });
  if (source === "cursor") return discoverCursorSession(session.filePath, session.updatedAtMs);
  return withDatabase(session.filePath, (db): DatabaseSession | null => {
    const row = db
      .prepare(
        "SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ? AND parent_id IS NULL",
      )
      .get(session.sessionId);
    if (row === undefined) return null;
    const metadata = decodeOpenCodeSession(row);
    return { ...session, cwd: metadata.directory, updatedAtMs: metadata.time_updated };
  });
}

function iso(timestamp: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(timestamp));
}

function finishThread(input: {
  source: "cursor" | "opencode";
  providerInstanceId: ProviderInstanceId;
  providerSessionId: string;
  title: string;
  model: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  messages: ReadonlyArray<AgentSessionThreadMessage>;
}): AgentSessionThread | null {
  const firstUser = input.messages.find((message) => message.role === "user");
  if (firstUser === undefined) return null;
  const messages = input.messages.slice(-MAX_MESSAGES);
  if (!messages.includes(firstUser)) messages.splice(0, 1, firstUser);
  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    title: input.title.trim() || firstUser.text.split("\n")[0]!.slice(0, 100) || "Imported thread",
    model: input.model,
    createdAt: iso(input.createdAtMs),
    updatedAt: iso(input.updatedAtMs),
    messages,
  };
}

export function readCursorThread(
  session: DatabaseSession,
  providerInstanceId: ProviderInstanceId,
  budget: DatabaseReadBudget = newReadBudget(),
) {
  return withDatabase(session.filePath, (db) => {
    const metadata = readCursorMetadata(db);
    if (metadata === null || metadata.meta.agentId !== session.sessionId) return null;
    const { meta, root, cwd } = metadata;
    const read = cursorReader(db, budget);
    const messages: Array<AgentSessionThreadMessage> = [];
    const append = (role: "user" | "assistant", value: Uint8Array | undefined) => {
      const text = value === undefined ? "" : Buffer.from(value).toString("utf8").trim();
      if (text) messages.push({ role, text, createdAt: iso(meta.createdAt) });
    };
    // Follow only the active root's turns. Old blobs can contain abandoned edits,
    // tool output, and copies of the entire prompt; table order is not chat order.
    for (const turnId of root.get(8) ?? []) {
      const agentTurn = protobufFields(read(turnId)).get(1)?.[0];
      if (agentTurn === undefined) continue;
      const turn = protobufFields(agentTurn);
      const userId = turn.get(1)?.[0];
      if (userId !== undefined) {
        const user = protobufFields(read(userId));
        const textId = user.get(18)?.[0];
        append("user", textId === undefined ? user.get(1)?.[0] : read(textId));
      }
      for (const stepId of turn.get(2) ?? []) {
        const assistant = protobufFields(read(stepId)).get(1)?.[0];
        if (assistant !== undefined) append("assistant", protobufFields(assistant).get(1)?.[0]);
      }
    }
    const thread = finishThread({
      source: "cursor",
      providerInstanceId,
      providerSessionId: meta.agentId,
      title: meta.name ?? "",
      model: meta.lastUsedModel ?? null,
      createdAtMs: meta.createdAt,
      updatedAtMs: session.updatedAtMs,
      messages,
    });
    return thread === null ? null : { cwd, thread };
  });
}

export function readOpenCodeThread(
  session: DatabaseSession,
  providerInstanceId: ProviderInstanceId,
  budget: DatabaseReadBudget = newReadBudget(),
) {
  return withDatabase(session.filePath, (db) => {
    const row = db
      .prepare(
        "SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ? AND parent_id IS NULL",
      )
      .get(session.sessionId);
    if (row === undefined) return null;
    const metadata = decodeOpenCodeSession(row);
    const messages: Array<AgentSessionThreadMessage> = [];
    let model: string | null = null;

    const reserve = (value: unknown) => {
      if (--budget.recordsRemaining < 0 || typeof value !== "string")
        throw new Error("OpenCode history record limit");
      budget.bytesRemaining -= Buffer.byteLength(value);
      if (budget.bytesRemaining < 0) throw new Error("OpenCode history byte limit");
      return value;
    };
    const append = (data: typeof OpenCodeMessage.Type, text: string, timestamp: number) => {
      const providerID = data.model?.providerID ?? data.model?.provider ?? data.providerID;
      const modelID = data.model?.modelID ?? data.model?.model ?? data.modelID;
      if (providerID && modelID) model = `${providerID}/${modelID}`;
      const role = data.role ?? data.type;
      if ((role === "user" || role === "assistant") && text.trim()) {
        messages.push({ role, text: text.trim(), createdAt: iso(timestamp) });
      }
    };
    // OpenCode 2 stores complete messages; older sessions keep messages and parts.
    const hasV2 =
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_message'")
        .get() !== undefined;
    const v2Count = hasV2
      ? db
          .prepare("SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1")
          .get(session.sessionId)
      : undefined;
    if (v2Count !== undefined) {
      for (const entry of db
        .prepare(
          "SELECT CASE WHEN length(CAST(data AS BLOB)) <= 33554432 THEN data END AS data, time_created FROM session_message WHERE session_id = ? ORDER BY seq LIMIT ?",
        )
        .iterate(session.sessionId, Math.max(0, budget.recordsRemaining) + 1)) {
        const parsed = decodeMessage(reserve(entry.data));
        if (Option.isNone(parsed) || typeof entry.time_created !== "number") continue;
        const data = parsed.value;
        const text =
          data.type === "user"
            ? (data.text ?? "")
            : (data.content ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text ?? "")
                .join("\n");
        append(data, text, entry.time_created);
      }
    } else {
      const parts = db.prepare(
        "SELECT CASE WHEN length(CAST(data AS BLOB)) <= 33554432 THEN data END AS data FROM part WHERE message_id = ? ORDER BY time_created, id LIMIT ?",
      );
      for (const entry of db
        .prepare(
          "SELECT id, CASE WHEN length(CAST(data AS BLOB)) <= 33554432 THEN data END AS data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ?",
        )
        .iterate(session.sessionId, Math.max(0, budget.recordsRemaining) + 1)) {
        const parsed = decodeMessage(reserve(entry.data));
        if (
          Option.isNone(parsed) ||
          typeof entry.id !== "string" ||
          typeof entry.time_created !== "number"
        )
          continue;
        const texts: Array<string> = [];
        for (const part of parts.iterate(entry.id, Math.max(0, budget.recordsRemaining) + 1)) {
          const parsedPart = decodePart(reserve(part.data));
          if (
            Option.isSome(parsedPart) &&
            parsedPart.value.type === "text" &&
            !parsedPart.value.synthetic &&
            !parsedPart.value.ignored
          ) {
            texts.push(parsedPart.value.text ?? "");
          }
        }
        append(parsed.value, texts.join("\n"), entry.time_created);
      }
    }
    const thread = finishThread({
      source: "opencode",
      providerInstanceId,
      providerSessionId: metadata.id,
      title: metadata.title,
      model,
      createdAtMs: metadata.time_created,
      updatedAtMs: metadata.time_updated,
      messages,
    });
    return thread === null ? null : { cwd: metadata.directory, thread };
  });
}
