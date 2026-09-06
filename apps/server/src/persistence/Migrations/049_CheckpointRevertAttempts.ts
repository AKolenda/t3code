import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE checkpoint_revert_attempts (
      thread_id TEXT PRIMARY KEY NOT NULL,
      attempt_id TEXT NOT NULL,
      attempt_json TEXT NOT NULL
    )
  `;
});
