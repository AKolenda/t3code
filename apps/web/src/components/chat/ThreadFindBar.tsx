import type { LegendListRef } from "@legendapp/list/react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { isMacPlatform } from "../../lib/utils";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

// Folds ASCII only so match offsets line up with the original text.
const fold = (text: string) => text.replace(/[A-Z]/g, (character) => character.toLowerCase());
const indexesOf = (text: string, needle: string) => {
  const found: number[] = [];
  for (
    let at = needle ? text.indexOf(needle) : -1;
    at !== -1;
    at = text.indexOf(needle, at + needle.length)
  ) {
    found.push(at);
  }
  return found;
};
const foldedRows = new WeakMap<MessagesTimelineRow, string>();
const rowText = (row: MessagesTimelineRow) => {
  let text = foldedRows.get(row);
  if (text === undefined) {
    const raw =
      row.kind === "message"
        ? row.message.text
        : row.kind === "proposed-plan"
          ? row.proposedPlan.planMarkdown
          : "";
    foldedRows.set(row, (text = fold(raw)));
  }
  return text;
};

/** Chrome-style find in the open thread: Ctrl/Cmd+F, Enter, Shift+Enter, Esc. */
export function ThreadFindBar(props: {
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: React.RefObject<LegendListRef | null>;
  onManualNavigation: () => void;
}) {
  const { rows, listRef, onManualNavigation } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const needle = open ? fold(deferredQuery.trim()) : "";

  // Capture phase, so Esc closes from anywhere and wins over other Esc handlers.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.select());
      } else if (open && event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const matches = useMemo(
    () =>
      needle.length === 0
        ? []
        : rows.flatMap((row, rowIndex) =>
            indexesOf(rowText(row), needle).map((_, nth) => ({ rowIndex, rowId: row.id, nth })),
          ),
    [rows, needle],
  );
  const activeIndex = Math.min(current, matches.length - 1);
  const match = matches[activeIndex];
  // Keyed so streaming rows don't re-trigger the jump to the same match.
  const active = useMemo(() => match, [needle, match?.rowId, match?.nth]);

  // Highlights only the rendered rows, so the cost tracks the viewport, not the thread.
  const paint = useCallback(
    (reveal: boolean) => {
      const scroller = listRef.current?.getScrollableNode() as HTMLElement | undefined;
      if (!scroller || typeof Highlight === "undefined" || !CSS.highlights) return true;
      const all = new Highlight();
      const activeRanges: Range[] = [];
      const activeRow =
        active && scroller.querySelector(`[data-timeline-row-id="${CSS.escape(active.rowId)}"]`);
      const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
      for (let node = needle ? walker.nextNode() : null; node; node = walker.nextNode()) {
        for (const at of indexesOf(fold(node.nodeValue!), needle)) {
          const range = new Range();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          all.add(range);
          if (activeRow?.contains(node)) activeRanges.push(range);
        }
      }
      const range = active && activeRanges[Math.min(active.nth, activeRanges.length - 1)];
      CSS.highlights.set("t3-thread-find", all);
      CSS.highlights.set("t3-thread-find-current", range ? new Highlight(range) : new Highlight());
      if (reveal && range) {
        // The composer overlays the list bottom, so park the match in the upper third.
        const view = scroller.getBoundingClientRect();
        scroller.scrollTop += range.getBoundingClientRect().top - view.top - view.height / 3;
      }
      return !active || range !== undefined;
    },
    [active, listRef, needle],
  );

  // Jump to the active match, then retry until its row is rendered.
  useEffect(() => {
    if (!open) return;
    if (active) {
      onManualNavigation();
      void listRef.current?.scrollToIndex({ index: active.rowIndex, viewOffset: 80 });
    }
    let frame = 0;
    let tries = 0;
    const tick = () => {
      if (!paint(true) && ++tries < 10) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, listRef, onManualNavigation, open, paint]);

  // Repaint as rows mount while scrolling or stream in; clear on close.
  useEffect(() => {
    const scroller = listRef.current?.getScrollableNode() as HTMLElement | undefined;
    if (!open || !scroller) {
      CSS.highlights?.delete("t3-thread-find");
      CSS.highlights?.delete("t3-thread-find-current");
      return;
    }
    paint(false);
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => paint(false));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [listRef, open, paint, rows]);

  if (!open) return null;
  const step = (delta: number) =>
    matches.length > 0 && setCurrent((index) => (index + delta + matches.length) % matches.length);

  return (
    <div className="fixed top-13 right-3 z-50 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 pl-2 text-popover-foreground shadow-lg">
      <input
        ref={inputRef}
        value={query}
        aria-label="Find in thread"
        className="w-48 bg-transparent text-sm outline-none"
        onChange={(event) => {
          setQuery(event.target.value);
          setCurrent(0);
        }}
        onKeyDown={(event) => event.key === "Enter" && step(event.shiftKey ? -1 : 1)}
      />
      <span className="min-w-12 text-right text-xs text-muted-foreground tabular-nums">
        {needle ? `${activeIndex + 1}/${matches.length}` : ""}
      </span>
      {(
        [
          ["Previous match", ChevronUpIcon, () => step(-1)],
          ["Next match", ChevronDownIcon, () => step(1)],
          ["Close find", XIcon, () => setOpen(false)],
        ] as const
      ).map(([label, Icon, onClick]) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          className="rounded p-1 hover:bg-accent"
          onClick={onClick}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
