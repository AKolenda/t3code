import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("048_ProjectionPendingOperation", (it) => {
  it.effect("preserves pending compaction and ordinary messages across upgrade", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      const messages = [
        { id: "compact", text: "\t /CoMpAcT\n", attachments: null },
        { id: "arguments", text: "/compact keep recent edits", attachments: null },
        { id: "ordinary", text: "hello", attachments: null },
        {
          id: "attachment",
          text: "/compact",
          attachments:
            '[{"type":"image","id":"image","name":"image.png","mimeType":"image/png","sizeBytes":1}]',
        },
      ];
      for (const message of messages) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
          ) VALUES (
            ${message.id}, ${message.id}, 'user', ${message.text}, ${message.attachments}, 0,
            '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, pending_message_id, state, requested_at, checkpoint_files_json
          ) VALUES (
            ${message.id}, ${message.id}, 'pending', '2026-09-05T00:00:00.000Z', '[]'
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 48 });
      const rows = yield* sql<{ readonly id: string; readonly kind: string | null }>`
        SELECT pending_message_id AS id, operation_kind AS kind
        FROM projection_turns ORDER BY pending_message_id
      `;
      assert.deepStrictEqual(rows, [
        { id: "arguments", kind: "turn" },
        { id: "attachment", kind: "turn" },
        { id: "compact", kind: "compact" },
        { id: "ordinary", kind: "turn" },
      ]);

      // Old servers can still insert rows without the new column.
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, pending_message_id, state, requested_at, checkpoint_files_json
        ) VALUES ('downgrade', 'compact', 'pending', '2026-09-05T00:00:01.000Z', '[]')
      `;
      const legacyRows = yield* sql<{ readonly kind: string | null }>`
        SELECT operation_kind AS kind FROM projection_turns WHERE thread_id = 'downgrade'
      `;
      assert.deepStrictEqual(legacyRows, [{ kind: null }]);
    }),
  );
});
