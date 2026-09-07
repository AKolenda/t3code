import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, FlatList, Modal, PanResponder, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { pendingThreadOrderAtom } from "../../state/thread-order";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useThreadListActions } from "../home/useThreadListActions";
import { createThreadMovePlanner, type ThreadMoveDestination } from "./threadOrder";
import { getThreadListV2OrderedSection } from "./threadListV2";

const ROW_HEIGHT = 72;
const keyOf = (thread: EnvironmentThreadShell) => scopedThreadKey(thread.environmentId, thread.id);

type Drag = {
  thread: EnvironmentThreadShell;
  destination: Exclude<ThreadMoveDestination, string> | null;
  candidate: string | null;
};

/** A handle owns its touch from the start; touches on the row still scroll. */
function DragHandle(props: {
  title: string;
  disabled: boolean;
  onStart: (pageY: number) => void;
  onMove: (pageY: number) => void;
  onEnd: (cancelled: boolean) => void;
  onStep: (direction: "up" | "down") => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const latest = useRef(props);
  latest.current = props;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !latest.current.disabled,
        onPanResponderGrant: (event) => latest.current.onStart(event.nativeEvent.pageY),
        onPanResponderMove: (_, gesture) => latest.current.onMove(gesture.moveY),
        onPanResponderRelease: () => latest.current.onEnd(false),
        onPanResponderTerminate: () => latest.current.onEnd(true),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`Reorder ${props.title}`}
      accessibilityHint="Drag to a new position, or use the move actions"
      accessibilityState={{ disabled: props.disabled }}
      accessibilityActions={[
        ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
        ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (props.disabled) return;
        if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
        if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
      }}
      className="h-12 w-12 items-center justify-center"
      style={{ opacity: props.disabled ? 0.3 : 1 }}
    >
      <SymbolView name="line.3.horizontal" size={22} tintColorClassName="accent-foreground-muted" />
    </View>
  );
}

export function ThreadArrangementSheet(props: {
  section: "pinned" | "active";
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const queuedThreadKeys = useAtomValue(queuedThreadKeysAtom);
  const pendingOrder = useAtomValue(pendingThreadOrderAtom);
  const { moveThread } = useThreadListActions();
  const [now, setNow] = useState(() => new Date().toISOString());
  // Wake times can change section membership while this sheet is open.
  useEffect(() => {
    const wakeAt = Math.min(
      ...threads.flatMap((thread) => {
        const at = Date.parse(thread.snoozedUntil ?? "");
        return at > Date.parse(now) ? [at] : [];
      }),
    );
    if (!Number.isFinite(wakeAt)) return;
    const timer = setTimeout(
      () => setNow(new Date().toISOString()),
      Math.min(Math.max(0, wakeAt - Date.now()) + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [threads, now]);
  const ordered = useMemo(
    () =>
      getThreadListV2OrderedSection({
        threads,
        section: props.section,
        now,
        queuedThreadKeys,
        pendingOrder,
        settlementEnvironmentIds: new Set(
          [...configs].flatMap(([id, config]) =>
            config.environment.capabilities.threadSettlement ? [id] : [],
          ),
        ),
        snoozeEnvironmentIds: new Set(
          [...configs].flatMap(([id, config]) =>
            config.environment.capabilities.threadSnooze ? [id] : [],
          ),
        ),
      }),
    [threads, props.section, now, queuedThreadKeys, pendingOrder, configs],
  );
  const planner = useMemo(
    () =>
      createThreadMovePlanner({
        ordered,
        allThreads: threads,
        section: props.section,
        reorderableEnvironmentIds: new Set(
          [...configs].flatMap(([id, config]) =>
            (
              props.section === "pinned"
                ? config.environment.capabilities.threadPinReorder
                : config.environment.capabilities.threadActiveReorder
            )
              ? [id]
              : [],
          ),
        ),
      }),
    [ordered, threads, props.section, configs],
  );
  const list = useRef<FlatList<EnvironmentThreadShell>>(null);
  const viewport = useRef<View>(null);
  const geometry = useRef({ top: 0, height: 0, offset: 0, pageY: 0 });
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const gestureVersion = useRef(0);
  const [preview, setPreview] = useState<Drag | null>(null);
  const translateY = useRef(new Animated.Value(0)).current;
  const latest = useRef({ ordered, planner, moveThread });
  latest.current = { ordered, planner, moveThread };

  function stop() {
    gestureVersion.current += 1;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setPreview(null);
  }
  // Changes from another client must not leave a drag targeting a stale list.
  const orderVersion = ordered
    .map((row) => `${keyOf(row)}:${row.pinOrderKey}:${row.activeOrderKey}`)
    .join("|");
  useEffect(() => {
    stop();
  }, [orderVersion]);
  useEffect(
    () => () => {
      gestureVersion.current += 1;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  function update(pageY: number) {
    const current = drag.current;
    if (current === null) return;
    const bounds = geometry.current;
    bounds.pageY = pageY;
    const y = pageY - bounds.top;
    translateY.setValue(Math.max(0, Math.min(bounds.height - ROW_HEIGHT, y - ROW_HEIGHT / 2)));
    const position = Math.max(
      0,
      Math.min(latest.current.ordered.length - 1, Math.floor((y + bounds.offset) / ROW_HEIGHT)),
    );
    const target = latest.current.ordered[position];
    const destination =
      target && y >= 0 && y <= bounds.height
        ? {
            targetId: keyOf(target),
            placement:
              (y + bounds.offset) % ROW_HEIGHT < ROW_HEIGHT / 2
                ? ("before" as const)
                : ("after" as const),
          }
        : null;
    const candidate = destination ? `${destination.targetId}:${destination.placement}` : null;
    if (current.candidate === candidate) return;
    current.candidate = candidate;
    const valid =
      destination && latest.current.planner(keyOf(current.thread), destination) !== null
        ? destination
        : null;
    if (
      current.destination?.targetId !== valid?.targetId ||
      current.destination?.placement !== valid?.placement
    ) {
      current.destination = valid;
      setPreview({ ...current });
    }
  }

  function start(thread: EnvironmentThreadShell, pageY: number) {
    const version = ++gestureVersion.current;
    viewport.current?.measureInWindow((_, top, __, height) => {
      if (gestureVersion.current !== version) return;
      geometry.current = { ...geometry.current, top, height, pageY };
      drag.current = { thread, destination: null, candidate: null };
      setPreview({ ...drag.current });
      update(pageY);
      let last = performance.now();
      const tick = () => {
        if (drag.current === null) return;
        const timestamp = performance.now();
        const dt = Math.min(timestamp - last, 32);
        last = timestamp;
        const bounds = geometry.current;
        const y = bounds.pageY - bounds.top;
        const speed =
          y < 48
            ? -Math.min(1, (48 - y) / 48)
            : y > bounds.height - 48
              ? Math.min(1, (y - bounds.height + 48) / 48)
              : 0;
        if (speed !== 0) {
          const offset = Math.max(
            0,
            Math.min(
              latest.current.ordered.length * ROW_HEIGHT - bounds.height,
              bounds.offset + speed * dt * 0.5,
            ),
          );
          if (offset !== bounds.offset) {
            bounds.offset = offset;
            list.current?.scrollToOffset({ offset, animated: false });
            update(bounds.pageY);
          }
        }
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    });
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-screen"
        style={{
          paddingTop: Platform.OS === "ios" ? 16 : insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <View className="flex-row items-center justify-between gap-3 px-5 py-3">
          <Text className="flex-1 text-xl font-t3-semibold">Arrange {props.section} threads</Text>
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="min-h-11 justify-center px-3"
          >
            <Text className="text-base text-primary">Done</Text>
          </Pressable>
        </View>
        <Text className="px-5 pb-3 text-sm text-foreground-muted">
          Drag the handles to reorder. Changes save when you drop.
        </Text>
        <View ref={viewport} collapsable={false} className="flex-1" style={{ overflow: "hidden" }}>
          <FlatList
            ref={list}
            data={ordered}
            keyExtractor={keyOf}
            scrollEnabled={preview === null}
            onScroll={(event) => {
              geometry.current.offset = event.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
            getItemLayout={(_, index) => ({
              length: ROW_HEIGHT,
              offset: ROW_HEIGHT * index,
              index,
            })}
            extraData={{ preview, pendingOrder, planner }}
            renderItem={({ item }) => {
              const key = keyOf(item);
              const canMoveUp = pendingOrder === null && planner(key, "up") !== null;
              const canMoveDown = pendingOrder === null && planner(key, "down") !== null;
              const insertion =
                preview?.destination?.targetId === key ? preview.destination.placement : null;
              return (
                <View
                  style={{ height: ROW_HEIGHT }}
                  className="flex-row items-center border-b border-border-subtle px-5"
                >
                  <Text
                    numberOfLines={2}
                    className="flex-1 text-base"
                    style={{ opacity: key === (preview && keyOf(preview.thread)) ? 0.3 : 1 }}
                  >
                    {item.title}
                  </Text>
                  <DragHandle
                    title={item.title}
                    disabled={
                      pendingOrder !== null ||
                      (props.section === "pinned"
                        ? configs.get(item.environmentId)?.environment.capabilities.threadPinReorder
                        : configs.get(item.environmentId)?.environment.capabilities
                            .threadActiveReorder) !== true
                    }
                    canMoveUp={canMoveUp}
                    canMoveDown={canMoveDown}
                    onStep={(direction) => {
                      void moveThread(item, direction);
                    }}
                    onStart={(pageY) => start(item, pageY)}
                    onMove={update}
                    onEnd={(cancelled) => {
                      const current = drag.current;
                      stop();
                      if (!cancelled && current?.destination)
                        void moveThread(current.thread, current.destination);
                    }}
                  />
                  {insertion ? (
                    <View
                      pointerEvents="none"
                      className="absolute left-5 right-5 h-0.5 bg-primary"
                      style={insertion === "before" ? { top: 0 } : { bottom: 0 }}
                    />
                  ) : null}
                </View>
              );
            }}
          />
          {preview ? (
            <Animated.View
              pointerEvents="none"
              className="absolute left-5 right-5 justify-center rounded-xl bg-subtle-strong px-4"
              style={{ top: 0, height: ROW_HEIGHT, transform: [{ translateY }] }}
            >
              <Text numberOfLines={2} className="text-base font-t3-medium">
                {preview.thread.title}
              </Text>
            </Animated.View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
