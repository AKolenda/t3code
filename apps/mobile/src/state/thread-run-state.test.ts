import { describe, expect, it } from "vite-plus/test";

import { selectThreadRunStateSource } from "./thread-run-state";

const at = (updatedAt: string, source: string) => ({ updatedAt, source });

describe("selectThreadRunStateSource", () => {
  it("reads run state from whichever copy holds the newer event", () => {
    const retained = at("2026-09-26T10:00:00.000Z", "detail");
    const settledShell = at("2026-09-26T10:05:00.000Z", "shell");
    // A detail kept in memory (or on disk) while the turn finished elsewhere.
    expect(
      selectThreadRunStateSource({ detail: retained, detailIsLive: true, shell: settledShell }),
    ).toBe(settledShell);
    // The open view's stream is ahead of the coalesced thread list.
    const streamed = at("2026-09-26T10:06:00.000Z", "detail");
    expect(
      selectThreadRunStateSource({ detail: streamed, detailIsLive: true, shell: settledShell }),
    ).toBe(streamed);
  });

  it("prefers the detail on a tie", () => {
    const detail = at("2026-09-26T10:00:00.000Z", "detail");
    const shell = at("2026-09-26T10:00:00.000Z", "shell");
    expect(selectThreadRunStateSource({ detail, detailIsLive: false, shell })).toBe(detail);
  });

  it("trusts only a live detail before the thread list has loaded", () => {
    const detail = at("2026-09-26T10:00:00.000Z", "detail");
    expect(selectThreadRunStateSource({ detail, detailIsLive: true, shell: null })).toBe(detail);
    expect(selectThreadRunStateSource({ detail, detailIsLive: false, shell: null })).toBeNull();
  });

  it("uses the shell when there is no detail", () => {
    const shell = at("2026-09-26T10:00:00.000Z", "shell");
    expect(selectThreadRunStateSource({ detail: null, detailIsLive: false, shell })).toBe(shell);
  });
});
