import { describe, expect, it } from "@effect/vitest";
import { cursorImportedHistory } from "./CursorHistoryImport.ts";

describe("Cursor imported context", () => {
  it("bounds long histories while preserving the first request and recent conversation", () => {
    const result = cursorImportedHistory([
      { role: "user", text: "Original request" },
      { role: "assistant", text: "x".repeat(200_000) },
      { role: "user", text: "Latest request" },
    ]);
    expect(result.length).toBeLessThan(81_000);
    expect(result).toContain("Original request");
    expect(result).toContain("Latest request");
    expect(result).toContain("Earlier history omitted");
  });
});
