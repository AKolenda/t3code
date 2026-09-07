// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  discoverCursorSession,
  discoverCursorDesktopSessions,
  readCursorDesktopThread,
  refreshDatabaseSession,
  discoverOpenCodeSessions,
  readCursorThread,
  readOpenCodeThread,
} from "./AgentSessionDatabase.ts";

const temporaryDirectories: Array<string> = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});
function database() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-database-"));
  temporaryDirectories.push(directory);
  const filePath = NodePath.join(directory, "store.db");
  return { filePath, db: new NodeSqlite.DatabaseSync(filePath) };
}
const instanceId = ProviderInstanceId.make("custom-account");
const updatedAtMs = Date.parse("2026-09-06T10:00:00Z");
function field(number: number, data: Uint8Array | string): Buffer {
  const bytes = Buffer.from(data);
  const varint: Array<number> = [];
  let size = bytes.length;
  while (size >= 128) {
    varint.push((size & 127) | 128);
    size >>>= 7;
  }
  varint.push(size);
  return Buffer.concat([Buffer.from([(number << 3) | 2, ...varint]), bytes]);
}

describe("Cursor history", () => {
  function fixture() {
    const { db, filePath } = database();
    db.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)",
    );
    const blob = (data: Uint8Array) => {
      const id = NodeCrypto.createHash("sha256").update(data).digest();
      db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)").run(id.toString("hex"), data);
      return id;
    };
    const user = blob(field(1, "Fix the bug"));
    const answer = blob(field(1, field(1, "Fixed")));
    const tool = blob(field(2, field(1, "hidden tool result")));
    const reasoning = blob(field(3, field(1, "hidden reasoning")));
    const turn = blob(
      field(
        1,
        Buffer.concat([field(1, user), field(2, tool), field(2, reasoning), field(2, answer)]),
      ),
    );
    const root = blob(
      Buffer.concat([
        field(9, NodeURL.pathToFileURL(NodePath.dirname(filePath)).href),
        field(8, turn),
      ]),
    );
    // Unreachable versions must not be imported just because they exist in blobs.
    blob(field(1, field(1, "Abandoned reply")));
    const metadata = {
      agentId: "cursor-session",
      name: "Bug fix",
      createdAt: updatedAtMs - 1000,
      latestRootBlobId: root.toString("hex"),
      lastUsedModel: "sonnet-4.6",
    };
    db.prepare("INSERT INTO meta VALUES ('0', ?)").run(
      Buffer.from(JSON.stringify(metadata)).toString("hex"),
    );
    return { db, filePath, metadata };
  }
  it("reads the active conversation in order with resumable identity and no tools", () => {
    const { db, filePath } = fixture();
    db.close();
    const session = discoverCursorSession(filePath, updatedAtMs)!;
    const result = readCursorThread(session, instanceId)!;
    expect(result.cwd).toBe(NodePath.dirname(filePath));
    expect(result.thread).toMatchObject({
      providerSessionId: "cursor-session",
      providerInstanceId: instanceId,
      title: "Bug fix",
      model: "sonnet-4.6",
    });
    expect(result.thread.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Fix the bug" },
      { role: "assistant", text: "Fixed" },
    ]);
  });
  it("skips subagents and rejects missing blobs without partial history", () => {
    const { db, filePath, metadata } = fixture();
    const session = discoverCursorSession(filePath, updatedAtMs)!;
    db.prepare("DELETE FROM blobs WHERE id != ?").run(metadata.latestRootBlobId);
    expect(() => readCursorThread(session, instanceId)).toThrow("Missing or oversized Cursor blob");
    db.prepare("UPDATE meta SET value = ?").run(
      Buffer.from(
        JSON.stringify({ ...metadata, subagentInfo: { parentAgentId: "parent" } }),
      ).toString("hex"),
    );
    expect(discoverCursorSession(filePath, updatedAtMs)).toBeNull();
    db.close();
  });
});

describe("OpenCode history", () => {
  function fixture() {
    const { db, filePath } = database();
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)",
    );
    const addSession = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)");
    addSession.run(
      "selected",
      NodePath.dirname(filePath),
      "Fix",
      updatedAtMs - 1000,
      updatedAtMs,
      null,
    );
    addSession.run("other", "/other", "Other", updatedAtMs - 1000, updatedAtMs - 100, null);
    addSession.run("child", "/child", "Child", updatedAtMs, updatedAtMs, "selected");
    const message = (
      id: string,
      role: string,
      text: string,
      sessionId = "selected",
      time = updatedAtMs,
    ) => {
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
        id,
        sessionId,
        time,
        JSON.stringify({ role, providerID: "anthropic", modelID: "claude-sonnet-4-6" }),
      );
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
        id,
        id,
        time,
        JSON.stringify({ type: "text", text }),
      );
    };
    return { db, filePath, message };
  }
  it("discovers top-level sessions and reads only selected history from a live WAL", () => {
    const { db, filePath, message } = fixture();
    message("b", "assistant", "Fixed");
    message("a", "user", "Fix the bug", "selected", updatedAtMs - 1000);
    message("c", "user", "Other project prompt", "other");
    for (const [id, data] of [
      ["tool", { type: "tool", text: "Tool output" }],
      ["synthetic", { type: "text", text: "Setup", synthetic: true }],
      ["ignored", { type: "text", text: "Ignore", ignored: true }],
    ] as const)
      db.prepare("INSERT INTO part VALUES (?, 'a', ?, ?)").run(
        id,
        updatedAtMs,
        JSON.stringify(data),
      );
    const sessions = discoverOpenCodeSessions(filePath, 5);
    expect(sessions.map((session) => session.sessionId)).toEqual(["selected", "other"]);
    const result = readOpenCodeThread(sessions[0]!, instanceId)!;
    expect(() =>
      readOpenCodeThread(sessions[0]!, instanceId, { bytesRemaining: 1, recordsRemaining: 100 }),
    ).toThrow("OpenCode history byte limit");
    expect(() =>
      readOpenCodeThread(sessions[0]!, instanceId, { bytesRemaining: 10000, recordsRemaining: 1 }),
    ).toThrow("OpenCode history record limit");
    expect(result.thread.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result.thread.messages.map((message) => message.text)).toEqual(["Fix the bug", "Fixed"]);
    db.close();
  });
  it("keeps valid OpenCode sessions when another row has malformed metadata", () => {
    const { db, filePath } = fixture();
    db.prepare("INSERT INTO session VALUES ('invalid', NULL, NULL, ?, ?, NULL)").run(
      updatedAtMs,
      updatedAtMs + 1,
    );
    expect(discoverOpenCodeSessions(filePath, 2).map((s) => s.sessionId)).toEqual([
      "selected",
      "other",
    ]);
    db.close();
  });
  it("retains the first prompt and newest history within the message limit", () => {
    const { db, filePath, message } = fixture();
    for (let i = 0; i < 205; i++)
      message(
        `m-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        `Message ${i}`,
        "selected",
        updatedAtMs + i,
      );
    const result = readOpenCodeThread(discoverOpenCodeSessions(filePath, 5)[0]!, instanceId)!;
    expect(result.thread.messages).toHaveLength(200);
    expect(result.thread.messages[0]?.text).toBe("Message 0");
    expect(result.thread.messages[1]?.text).toBe("Message 6");
    expect(result.thread.messages.at(-1)?.text).toBe("Message 204");
    db.close();
  });
  it("supports OpenCode 2 messages without duplicating legacy copies", () => {
    const { db, filePath, message } = fixture();
    message("legacy", "user", "Legacy copy");
    db.exec(
      "CREATE TABLE session_message (session_id TEXT, seq INTEGER, time_created INTEGER, data TEXT)",
    );
    const add = db.prepare("INSERT INTO session_message VALUES ('selected', ?, ?, ?)");
    add.run(
      2,
      updatedAtMs,
      JSON.stringify({
        type: "assistant",
        model: { provider: "opencode", model: "big-pickle" },
        content: [
          { type: "reasoning", text: "Hidden" },
          { type: "text", text: "Fixed" },
          { type: "text", text: "Generated context", synthetic: true },
          { type: "text", text: "Ignored context", ignored: true },
        ],
      }),
    );
    add.run(1, updatedAtMs - 1000, JSON.stringify({ type: "user", text: "Fix the bug" }));
    const result = readOpenCodeThread(discoverOpenCodeSessions(filePath, 5)[0]!, instanceId)!;
    expect(result.thread.messages.map((message) => message.text)).toEqual(["Fix the bug", "Fixed"]);
    expect(result.thread.model).toBe("opencode/big-pickle");
    db.close();
  });
});

describe("Cursor desktop history", () => {
  function fixture() {
    const { filePath, db } = database();
    db.exec(
      "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)",
    );
    const put = (key: string, value: unknown) =>
      db
        .prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)")
        .run(key, JSON.stringify(value));
    const composer = {
      composerId: "desktop",
      createdAt: updatedAtMs - 1000,
      lastUpdatedAt: updatedAtMs,
      workspaceIdentifier: { uri: { scheme: "file", fsPath: NodePath.dirname(filePath) } },
      name: "Desktop fix",
      modelConfig: { modelName: "grok-4.5" },
      fullConversationHeadersOnly: [
        { bubbleId: "user", type: 1 },
        { bubbleId: "tool", type: 2 },
        { bubbleId: "answer", type: 2 },
      ],
    };
    put("composerData:desktop", composer);
    put("bubbleId:desktop:user", {
      bubbleId: "user",
      type: 1,
      text: "Fix desktop history",
      createdAt: "2026-09-06T09:59:59Z",
    });
    put("bubbleId:desktop:tool", {
      bubbleId: "tool",
      type: 2,
      text: "",
      toolFormerData: { result: "x".repeat(2 * 1024 * 1024) },
    });
    put("bubbleId:desktop:answer", {
      bubbleId: "answer",
      type: 2,
      text: "Fixed",
      createdAt: "2026-09-06T10:00:00Z",
    });
    put("bubbleId:desktop:abandoned", { bubbleId: "abandoned", type: 2, text: "Abandoned answer" });
    return { filePath, db, put, composer };
  }
  it("reads ordered editor bubbles without loading tool payloads or abandoned replies", () => {
    const { filePath, db, put, composer } = fixture();
    put("composerData:desktop", { ...composer, fileSnapshot: "x".repeat(2 * 1024 * 1024) });
    const { sessions } = discoverCursorDesktopSessions(filePath, 100);
    expect(sessions).toHaveLength(1);
    const snapshot = readCursorDesktopThread(sessions[0]!, instanceId, {
      bytesRemaining: 4096,
      recordsRemaining: 10,
    })!;
    expect(snapshot.thread).toMatchObject({
      title: "Desktop fix",
      model: "grok-4.5",
      providerSessionId: "desktop",
    });
    expect(snapshot.thread.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Fix desktop history" },
      { role: "assistant", text: "Fixed" },
    ]);
    expect(snapshot.thread.messages[0]!.createdAt).toBe("2026-09-06T09:59:59.000Z");
    db.close();
  });
  it("finds older valid sessions after newer unusable composers", () => {
    const { filePath, db, put, composer } = fixture();
    for (const [index, extra] of [
      { subagentInfo: { parentComposerId: "parent" } },
      { workspaceIdentifier: { uri: { scheme: "vscode-remote", path: "/remote" } } },
      { workspaceIdentifier: undefined },
      { createdAt: "invalid" },
    ].entries()) {
      put(`composerData:newer-${index}`, {
        ...composer,
        ...extra,
        composerId: `newer-${index}`,
        lastUpdatedAt: updatedAtMs + index + 1,
      });
    }
    expect(discoverCursorDesktopSessions(filePath, 1).sessions).toMatchObject([
      { sessionId: "desktop" },
    ]);
    db.close();
  });
  it.each(["composer", "bubble"])("enforces UTF-8 byte limits on desktop %s JSON", (location) => {
    const { filePath, db, put, composer } = fixture();
    const text = "界".repeat(1000);
    if (location === "composer") {
      put("composerData:desktop", {
        ...composer,
        fullConversationHeadersOnly: [],
        conversation: [{ bubbleId: "user", type: 1, text }],
      });
    } else {
      put("bubbleId:desktop:answer", { bubbleId: "answer", type: 2, text });
    }
    const session = discoverCursorDesktopSessions(filePath, 1).sessions[0]!;
    const budget = { bytesRemaining: 2048, recordsRemaining: 10 };
    expect(() => readCursorDesktopThread(session, instanceId, budget)).toThrow(
      `Missing or oversized Cursor ${location}`,
    );
    expect(budget.bytesRemaining).toBeGreaterThanOrEqual(0);
    db.close();
  });
  it("omits thought and summary bubbles whose flags only exist in their stored bodies", () => {
    const { filePath, db, put, composer } = fixture();
    put("composerData:desktop", {
      ...composer,
      fullConversationHeadersOnly: [
        ...composer.fullConversationHeadersOnly,
        { bubbleId: "thought", type: 2 },
        { bubbleId: "summary", type: 2 },
      ],
    });
    put("bubbleId:desktop:thought", {
      bubbleId: "thought",
      type: 2,
      text: "Hidden thought",
      isThought: true,
    });
    put("bubbleId:desktop:summary", {
      bubbleId: "summary",
      type: 2,
      text: "Hidden summary",
      isSummary: true,
    });
    const session = discoverCursorDesktopSessions(filePath, 1).sessions[0]!;
    expect(
      readCursorDesktopThread(session, instanceId)?.thread.messages.map((m) => m.text),
    ).toEqual(["Fix desktop history", "Fixed"]);
    db.close();
  });
  it("skips oversized raw composers before parsing and reports an incomplete scan", () => {
    const { filePath, db, put, composer } = fixture();
    const session = discoverCursorDesktopSessions(filePath, 1).sessions[0]!;
    put("composerData:oversized", {
      ...composer,
      composerId: "oversized",
      fileSnapshot: "x".repeat(32 * 1024 * 1024),
    });
    const discovery = discoverCursorDesktopSessions(filePath, 10);
    expect(discovery.sessions.map((s) => s.sessionId)).toEqual(["desktop"]);
    expect(discovery.truncated).toBe(true);
    db.prepare(
      "UPDATE cursorDiskKV SET value = (SELECT value FROM cursorDiskKV WHERE key = 'composerData:oversized') WHERE key = 'composerData:desktop'",
    ).run();
    expect(readCursorDesktopThread(session, instanceId)).toBeNull();
    db.close();
  });
  it("skips empty drafts, subagents, and remote workspaces", () => {
    const { filePath, db, put, composer } = fixture();
    for (const extra of [
      { fullConversationHeadersOnly: [] },
      { subagentInfo: { parentComposerId: "parent" } },
      { workspaceIdentifier: { uri: { scheme: "vscode-remote", path: "/project" } } },
    ]) {
      put("composerData:desktop", { ...composer, ...extra });
      expect(discoverCursorDesktopSessions(filePath, 100)).toEqual({
        sessions: [],
        truncated: false,
      });
    }
    db.close();
  });
  it("rechecks project ownership and rejects incomplete or oversized visible history", () => {
    const { filePath, db, put, composer } = fixture();
    const session = discoverCursorDesktopSessions(filePath, 100).sessions[0]!;
    put("composerData:desktop", {
      ...composer,
      workspaceIdentifier: { uri: { scheme: "file", fsPath: "/moved" } },
    });
    expect(refreshDatabaseSession(session, "cursor")?.cwd).toBe("/moved");
    expect(() =>
      readCursorDesktopThread(session, instanceId, { bytesRemaining: 10, recordsRemaining: 10 }),
    ).toThrow();
    db.prepare("DELETE FROM cursorDiskKV WHERE key = 'bubbleId:desktop:answer'").run();
    expect(() => readCursorDesktopThread(session, instanceId)).toThrow(
      "Missing or oversized Cursor bubble",
    );
    db.close();
  });
  it("reads legacy inline conversations and current header titles", () => {
    const { filePath, db, put, composer } = fixture();
    put("composerData:desktop", {
      ...composer,
      fullConversationHeadersOnly: [],
      conversation: [
        { bubbleId: "user", type: 1, text: "Old question" },
        { bubbleId: "reply", type: 2, text: "Old answer" },
        {
          bubbleId: "simulated-user",
          type: 1,
          text: "Generated prompt",
          grouping: { isSimulatedMsg: true },
        },
        {
          bubbleId: "simulated-answer",
          type: 2,
          text: "Generated answer",
          grouping: { isSimulatedMsg: true },
        },
      ],
    });
    db.prepare("INSERT INTO composerHeaders VALUES (?, ?)").run(
      "desktop",
      JSON.stringify({ composerId: "desktop", name: "Renamed", lastUpdatedAt: updatedAtMs + 1000 }),
    );
    const session = discoverCursorDesktopSessions(filePath, 100).sessions[0]!;
    expect(session.updatedAtMs).toBe(updatedAtMs + 1000);
    expect(readCursorDesktopThread(session, instanceId)?.thread).toMatchObject({
      title: "Renamed",
      messages: [{ text: "Old question" }, { text: "Old answer" }],
    });
    db.close();
  });
});
