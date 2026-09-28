import { NavigationContext } from "@react-navigation/native";
import { use, useEffect, useSyncExternalStore } from "react";

/**
 * Counts in-screen UI that handles Android back in JS, such as an in-window
 * menu. Screens that let back pop them natively
 * (`unstable_nativeBackDismissalEnabled`, see withAndroidNativeScreenBack)
 * turn that off while any hold is active, so back reaches the JS handler and
 * closes that UI instead of the screen.
 */
let holds = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Returns the release function; releasing twice is a no-op. */
export function holdJsBack(): () => void {
  holds += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    emit();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isJsBackHeld() {
  return holds > 0;
}

export function useJsBackHeld(): boolean {
  return useSyncExternalStore(subscribe, isJsBackHeld);
}

/**
 * Holds while `active`. Inside a navigator it only holds while its screen is
 * focused, so UI left open on a covered screen doesn't hold the one on top.
 */
export function useJsBackHold(active: boolean) {
  const navigation = use(NavigationContext);
  useEffect(() => {
    if (!active) return;
    let release = navigation?.isFocused() === false ? null : holdJsBack();
    const removeFocus = navigation?.addListener("focus", () => {
      release ??= holdJsBack();
    });
    const removeBlur = navigation?.addListener("blur", () => {
      release?.();
      release = null;
    });
    return () => {
      removeFocus?.();
      removeBlur?.();
      release?.();
    };
  }, [active, navigation]);
}
