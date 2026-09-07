import type { PointerSensorProps } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarPointerSensor } from "./SidebarPointerSensor";

let document: EventTarget;
let window: EventTarget;

function pointer(type: string, buttons = 1, clientY = 0, pointerId = 1) {
  return Object.assign(new Event(type), { buttons, clientX: 0, clientY, pointerId });
}

function pickup() {
  const event = pointer("pointerdown");
  document.dispatchEvent(event);
  const callbacks = {
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
    onPending: vi.fn(),
  };
  const sensor = new SidebarPointerSensor({
    active: "thread",
    activeNode: {} as PointerSensorProps["activeNode"],
    context: {} as PointerSensorProps["context"],
    event,
    options: { activationConstraint: { distance: 6 } },
    ...callbacks,
  });
  return { ...callbacks, sensor };
}

beforeEach(() => {
  vi.useFakeTimers();
  document = Object.assign(new EventTarget(), { getSelection: () => null });
  window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
});

afterEach(() => {
  document.dispatchEvent(new Event("pointercancel"));
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sidebar pointer drag cleanup", () => {
  it("does not start a drag after a missed release", () => {
    const callbacks = pickup();
    document.dispatchEvent(pointer("pointermove", 0, 20));
    expect(callbacks.onStart).not.toHaveBeenCalled();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onAbort).toHaveBeenCalledWith("thread");
  });

  it("cancels an active drag when the button is no longer held", () => {
    const callbacks = pickup();
    document.dispatchEvent(pointer("pointermove", 1, 20));
    expect(callbacks.onStart).toHaveBeenCalledOnce();
    document.dispatchEvent(pointer("pointermove", 0, 40));
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onMove).not.toHaveBeenCalled();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });

  it.each([false, true])("cancels on window blur with an active drag of %s", (active) => {
    const callbacks = pickup();
    if (active) document.dispatchEvent(pointer("pointermove", 1, 20));
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(pointer("pointermove", 1, 40));
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onStart).toHaveBeenCalledTimes(active ? 1 : 0);
    expect(callbacks.onMove).not.toHaveBeenCalled();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });

  it("preserves normal drops and removes the extra listeners", () => {
    const callbacks = pickup();
    document.dispatchEvent(pointer("pointermove", 1, 20));
    document.dispatchEvent(pointer("pointermove", 1, 40));
    document.dispatchEvent(pointer("pointerup", 0, 40));
    const cancel = vi.fn();
    document.addEventListener("pointercancel", cancel);
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(pointer("pointermove", 0, 60));
    expect(callbacks.onMove).toHaveBeenCalledWith({ x: 0, y: 40 });
    expect(callbacks.onEnd).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("ignores button releases from another pointer", () => {
    const callbacks = pickup();
    document.dispatchEvent(pointer("pointermove", 1, 20));
    document.dispatchEvent(pointer("pointermove", 0, 20, 2));
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });
});
