import { describe, expect, it } from "vite-plus/test";

import { selectThreadRunStateSource } from "./thread-run-state";

const detail = { source: "detail" } as const;
const shell = { source: "shell" } as const;

describe("selectThreadRunStateSource", () => {
  it("reads run state from a live detail", () => {
    expect(selectThreadRunStateSource({ detail, detailIsLive: true, shell })).toBe(detail);
  });

  it("reads run state from the shell while the detail may be a stale cached copy", () => {
    expect(selectThreadRunStateSource({ detail, detailIsLive: false, shell })).toBe(shell);
  });

  it("falls back to whichever copy exists", () => {
    expect(selectThreadRunStateSource({ detail: null, detailIsLive: true, shell })).toBe(shell);
    expect(selectThreadRunStateSource({ detail, detailIsLive: false, shell: null })).toBe(detail);
    expect(
      selectThreadRunStateSource({ detail: null, detailIsLive: false, shell: null }),
    ).toBeNull();
  });
});
