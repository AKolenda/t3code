import { describe, expect, it, vi } from "vite-plus/test";

import { createSwipeRowActivation } from "./swipe-row-activation";

describe("createSwipeRowActivation", () => {
  it("activates exactly the requested rows and notifies only on change", () => {
    const activation = createSwipeRowActivation();
    const listener = vi.fn();
    activation.subscribe(listener);

    activation.activate(["a", "b"]);
    activation.activate(["b", "a"]);

    expect(activation.isActive("a")).toBe(true);
    expect(activation.isActive("c")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    activation.activate(["c"]);
    expect(activation.isActive("a")).toBe(false);
    expect(activation.isActive("c")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("defers changes while a finger is down so a press is never remounted", () => {
    const activation = createSwipeRowActivation();
    activation.activate(["a"]);

    activation.setTouching(true);
    activation.activate(["b"]);
    activation.activate(["c"]);
    expect(activation.isActive("a")).toBe(true);
    expect(activation.isActive("c")).toBe(false);

    activation.setTouching(false);
    expect(activation.isActive("a")).toBe(false);
    expect(activation.isActive("b")).toBe(false);
    expect(activation.isActive("c")).toBe(true);
  });

  it("stops notifying after unsubscribe", () => {
    const activation = createSwipeRowActivation();
    const listener = vi.fn();
    const unsubscribe = activation.subscribe(listener);
    unsubscribe();
    activation.activate(["a"]);
    expect(listener).not.toHaveBeenCalled();
  });
});
