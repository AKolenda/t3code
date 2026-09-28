import { createContext } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@react-navigation/native", () => ({ NavigationContext: createContext(undefined) }));

import { holdJsBack, isJsBackHeld } from "./jsBackHold";

describe("holdJsBack", () => {
  it("holds until every hold is released", () => {
    expect(isJsBackHeld()).toBe(false);
    const releaseFirst = holdJsBack();
    const releaseSecond = holdJsBack();
    expect(isJsBackHeld()).toBe(true);
    releaseFirst();
    expect(isJsBackHeld()).toBe(true);
    releaseSecond();
    expect(isJsBackHeld()).toBe(false);
  });

  it("ignores a second release of the same hold", () => {
    const releaseFirst = holdJsBack();
    const releaseSecond = holdJsBack();
    releaseFirst();
    releaseFirst();
    expect(isJsBackHeld()).toBe(true);
    releaseSecond();
    expect(isJsBackHeld()).toBe(false);
  });
});
