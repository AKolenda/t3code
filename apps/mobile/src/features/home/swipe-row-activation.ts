import { createContext, use, useSyncExternalStore } from "react";

/**
 * Full swipe rows (pan gesture, animated actions, hidden action buttons) only
 * exist around the viewport. Every other Home row stays mounted in a dormant
 * frame that paints the same content, so scrolling never rebuilds a row or
 * shows blank space, while an off-screen row keeps a fraction of its native
 * views. The scroll gate already disables swipes while the list moves, so rows
 * are activated once it rests.
 */
export function createSwipeRowActivation() {
  let activeKeys = new Set<string>();
  // Swapping a row's frame remounts it, which would cancel a press or long
  // press in progress, so changes wait for the finger to lift.
  let touching = false;
  let pendingKeys: ReadonlyArray<string> | null = null;
  const listeners = new Set<() => void>();
  const apply = (keys: ReadonlyArray<string>) => {
    if (keys.length === activeKeys.size && keys.every((key) => activeKeys.has(key))) return;
    activeKeys = new Set(keys);
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    isActive: (key: string) => activeKeys.has(key),
    activate(keys: ReadonlyArray<string>) {
      if (touching) pendingKeys = keys;
      else apply(keys);
    },
    setTouching(next: boolean) {
      touching = next;
      if (next || pendingKeys === null) return;
      const keys = pendingKeys;
      pendingKeys = null;
      apply(keys);
    },
  };
}

export type SwipeRowActivation = ReturnType<typeof createSwipeRowActivation>;

export const SwipeRowActivationContext = createContext<SwipeRowActivation | null>(null);

const subscribeNever = () => () => {};

/** Rows outside an activation provider (e.g. the iPad sidebar) stay live. */
export function useSwipeRowDormant(key: string | undefined): boolean {
  const activation = use(SwipeRowActivationContext);
  return useSyncExternalStore(
    activation?.subscribe ?? subscribeNever,
    () => activation !== null && key !== undefined && !activation.isActive(key),
  );
}
