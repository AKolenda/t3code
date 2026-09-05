import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Null identifies pending rows written by an older server after a downgrade.
  yield* sql`ALTER TABLE projection_turns ADD COLUMN operation_kind TEXT`;

  const pendingMessages = yield* sql<{
    readonly rowId: number;
    readonly text: string;
    readonly hasAttachments: number;
  }>`
    SELECT turns.row_id AS "rowId", messages.text,
      COALESCE(json_array_length(messages.attachments_json), 0) > 0 AS "hasAttachments"
    FROM projection_turns turns
    JOIN projection_thread_messages messages
      ON messages.message_id = turns.pending_message_id
      AND messages.thread_id = turns.thread_id
    WHERE turns.turn_id IS NULL AND turns.state = 'pending'
      AND turns.checkpoint_turn_count IS NULL AND messages.role = 'user'
  `;
  for (const message of pendingMessages) {
    const kind =
      message.hasAttachments === 0 && message.text.trim().toLowerCase() === "/compact"
        ? "compact"
        : "turn";
    yield* sql`UPDATE projection_turns SET operation_kind = ${kind} WHERE row_id = ${message.rowId}`;
  }
});
