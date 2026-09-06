import type { ProviderContextUsage } from "@t3tools/contracts";
import { Minimize2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ContextUsageBreakdown, type ContextUsageBreakdownState } from "./ContextUsageBreakdown";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { composerFloatingLayerProps } from "./composerEventScope";

/**
 * Fetches the provider's context breakdown, or returns a failure message.
 * Passed only for providers that report one (Claude today).
 */
export type ContextUsageLoader = () => Promise<
  | { readonly ok: true; readonly usage: ProviderContextUsage }
  | { readonly ok: false; readonly message: string }
>;

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
  loadBreakdown?: ContextUsageLoader | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const { loadBreakdown } = props;
  const [open, setOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<ContextUsageBreakdownState | null>(null);
  // The breakdown is a live read from the provider, so it is refetched when
  // the popover opens after the meter has moved. `updatedAt` changes once per
  // token-usage event, which is the cheapest "something happened" signal.
  const loadedForRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);

  const refreshBreakdown = useCallback(
    (loader: ContextUsageLoader) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      loadedForRef.current = usage.updatedAt;
      setBreakdown((current) => current ?? { status: "loading" });
      void loader().then((result) => {
        if (requestIdRef.current !== requestId) return;
        setBreakdown(
          result.ok
            ? { status: "ready", usage: result.usage }
            : { status: "error", message: result.message },
        );
      });
    },
    [usage.updatedAt],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen && loadBreakdown && loadedForRef.current !== usage.updatedAt) {
        refreshBreakdown(loadBreakdown);
      }
    },
    [loadBreakdown, refreshBreakdown, usage.updatedAt],
  );

  // A token-usage event while the popover is open (turn finishing under the
  // pointer) refreshes in place rather than showing a stale split.
  useEffect(() => {
    if (!open || !loadBreakdown || loadedForRef.current === usage.updatedAt) return;
    refreshBreakdown(loadBreakdown);
  }, [open, loadBreakdown, refreshBreakdown, usage.updatedAt]);

  const showBreakdown = loadBreakdown !== undefined && breakdown !== null;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact || loadBreakdown ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className={
          loadBreakdown
            ? "w-80 max-w-none text-left whitespace-normal"
            : "w-64 max-w-none text-left whitespace-normal"
        }
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {showBreakdown ? (
            <ContextUsageBreakdown state={breakdown} />
          ) : usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
