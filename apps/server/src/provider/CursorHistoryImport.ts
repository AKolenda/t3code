import * as Schema from "effect/Schema";

const MAX_IMPORTED_CONTEXT_CHARACTERS = 80_000;

/** CLI and editor histories cannot be loaded by Cursor's separate ACP store. */
export function cursorImportedHistory(
  messages: ReadonlyArray<{ role: string; text: string }>,
): string {
  const first = messages.find((message) => message.role === "user");
  const firstPrompt = first?.text.slice(0, 8000) ?? "";
  const history = messages.map((message) => `${message.role}:\n${message.text}`).join("\n\n");
  const retained =
    history.length <= MAX_IMPORTED_CONTEXT_CHARACTERS
      ? history
      : `First user message:\n${firstPrompt}\n\n[Earlier history omitted]\n${history.slice(-(MAX_IMPORTED_CONTEXT_CHARACTERS - firstPrompt.length - 100))}`;
  return `The following conversation was imported from Cursor. Use it as historical context for the next user message.\n\n${retained}\n\nEnd of imported history.`;
}

export const decodeCursorResume = Schema.decodeUnknownOption(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    sessionId: Schema.optional(Schema.String),
    importedHistory: Schema.optional(Schema.String),
  }),
);
