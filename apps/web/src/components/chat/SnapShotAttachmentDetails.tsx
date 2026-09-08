import type { SnapShotSource } from "@t3tools/contracts";
import { ImageIcon, TextIcon } from "lucide-react";
import { Suspense, use, useEffect, useMemo, useState, type CSSProperties } from "react";

import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import {
  rgbCss,
  sampleSnapShotBottomColor,
  snapShotOverlayTone,
  type SnapShotOverlayTone,
} from "../../lib/snapShotOverlayTone";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { cn } from "../../lib/utils";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const SNAP_SHOT_ATTACHMENT_FRAME_CLASS =
  "relative h-28 w-52 max-w-full overflow-hidden rounded-lg border border-border/80";

export interface SnapShotAccessibilityDetails {
  content: string;
  format: "json" | "text";
}

interface SyntaxToken {
  readonly content: string;
  readonly offset: number;
  readonly color?: string;
  readonly fontStyle?: number;
}

function syntaxTokenStyle(token: SyntaxToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  };
}

function HighlightedAccessibilityJson({
  content,
  theme,
}: {
  content: string;
  theme: "light" | "dark";
}) {
  const highlighter = use(getSyntaxHighlighterPromise("json"));
  const lines = useMemo(
    () =>
      highlighter.codeToTokens(content, {
        lang: "json",
        theme: resolveDiffThemeName(theme),
      }).tokens,
    [content, highlighter, theme],
  );

  let lineOffset = 0;
  return lines.map((line) => {
    const lineContent = line.map((token) => token.content).join("");
    const lineKey = `${lineOffset}:${lineContent}`;
    const hasNextLine = lineOffset + lineContent.length < content.length;
    lineOffset += lineContent.length + 1;
    return (
      <span key={lineKey}>
        {line.map((token) => (
          <span key={`${token.offset}:${token.content}`} style={syntaxTokenStyle(token)}>
            {token.content}
          </span>
        ))}
        {hasNextLine ? "\n" : null}
      </span>
    );
  });
}

export function SnapShotAccessibilityData({
  details,
  className,
}: {
  details: SnapShotAccessibilityDetails;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const content =
    details.format === "json" ? (
      <RenderErrorBoundary fallback={details.content}>
        <Suspense fallback={details.content}>
          <HighlightedAccessibilityJson content={details.content} theme={resolvedTheme} />
        </Suspense>
      </RenderErrorBoundary>
    ) : (
      details.content
    );

  return (
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap break-words font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        className,
      )}
      tabIndex={0}
    >
      {content}
    </pre>
  );
}

export function snapShotAccessibilityDetails(
  source: SnapShotSource,
): SnapShotAccessibilityDetails | undefined {
  if (source.accessibility?.format === "element-tree") {
    return {
      content: JSON.stringify(source.accessibility, null, 2),
      format: "json",
    };
  }

  const text =
    source.accessibility?.format === "flat-text"
      ? source.accessibility.text.trim()
      : source.accessibleText?.trim();
  return text ? { content: text, format: "text" } : undefined;
}

export function snapShotIncludesAccessibility(source: SnapShotSource): boolean {
  return Boolean(source.accessibility || source.accessibleText?.trim());
}

export function SnapShotContentsButton({
  source,
  className,
  side = "top",
  variant = "ghost-muted",
}: {
  source: SnapShotSource;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  variant?: "ghost-muted" | "overlay";
}) {
  const includesAccessibility = snapShotIncludesAccessibility(source);
  const ContentsIcon = includesAccessibility ? TextIcon : ImageIcon;
  const accessibilityDetails = snapShotAccessibilityDetails(source);
  const tooltip = includesAccessibility ? "Accessibility data" : "No accessibility data";

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label={
                    includesAccessibility ? "View accessibility data" : "No accessibility data"
                  }
                  className={cn("[--control-icon-color:currentColor]", className)}
                  onClick={(event) => event.stopPropagation()}
                  size="icon-micro"
                  variant={variant}
                />
              }
            />
          }
        >
          <ContentsIcon className="size-3" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side={side}>{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side={side}
        align="center"
        className="w-[min(24rem,calc(100vw-2rem))]"
        viewportClassName="max-h-[min(28rem,70vh)]"
      >
        <div className="space-y-2">
          <PopoverTitle className="text-sm leading-5">Accessibility data</PopoverTitle>
          {accessibilityDetails ? (
            <SnapShotAccessibilityData
              details={accessibilityDetails}
              className="max-h-64 rounded-md border border-border/70 bg-muted/45 p-2.5 text-[11px] leading-4"
            />
          ) : includesAccessibility ? (
            <div className="rounded-md border border-border/70 bg-muted/45 p-2.5 text-muted-foreground text-xs leading-4">
              Structured accessibility elements were included, but they have no readable names or
              values.
            </div>
          ) : (
            <div className="rounded-md border border-border/70 bg-muted/45 p-2.5 text-muted-foreground text-xs leading-4">
              The app or capture backend did not provide verified accessibility data.
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Samples the thumbnail's bottom band so the overlay can extend the image in
 * its own tone. Null until the sample lands or when the pixels are unreadable.
 * The result is keyed by URL so a thumbnail that swaps from its blob preview
 * to the uploaded asset never wears the previous image's tone.
 */
function useSnapShotOverlayTone(src: string | undefined): SnapShotOverlayTone | null {
  const [sample, setSample] = useState<{
    readonly src: string;
    readonly tone: SnapShotOverlayTone | null;
  } | null>(null);
  useEffect(() => {
    if (src === undefined) return;
    let cancelled = false;
    void sampleSnapShotBottomColor(src).then((color) => {
      if (cancelled) return;
      setSample({ src, tone: color === null ? null : snapShotOverlayTone(color) });
    });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return sample !== null && sample.src === src ? sample.tone : null;
}

export function SnapShotAttachmentDetails({
  source,
  src,
  className,
}: {
  source: SnapShotSource;
  /** Thumbnail URL the overlay sits on; sampled for the overlay's tone. */
  src?: string | undefined;
  className?: string;
}) {
  const tone = useSnapShotOverlayTone(src);
  const style = useMemo<CSSProperties | undefined>(
    () =>
      tone === null
        ? undefined
        : ({
            "--snap-shot-scrim": rgbCss(tone.scrim),
            "--snap-shot-scrim-mid": rgbCss(tone.scrim, 0.7),
            "--snap-shot-text": rgbCss(tone.text),
            "--snap-shot-text-muted": rgbCss(tone.text, 0.72),
            "--snap-shot-badge": rgbCss(tone.text, 0.14),
          } as CSSProperties),
    [tone],
  );
  return (
    <div
      style={style}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 px-2.5 pb-2 pt-6",
        "[--snap-shot-scrim:rgb(0_0_0)] [--snap-shot-scrim-mid:rgb(0_0_0/70%)] [--snap-shot-text:rgb(255_255_255)] [--snap-shot-text-muted:rgb(255_255_255/72%)] [--snap-shot-badge:rgb(255_255_255/14%)]",
        "bg-linear-to-t from-(--snap-shot-scrim) via-(--snap-shot-scrim-mid) to-transparent text-(--snap-shot-text)",
        className,
      )}
    >
      {source.appIconDataUrl ? (
        <img src={source.appIconDataUrl} alt="" className="size-7 shrink-0 rounded-md" />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-(--snap-shot-badge) text-[10px] font-medium uppercase">
          {source.appName.slice(0, 1)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium leading-3.5">
          <span className="truncate">{source.appName}</span>
          <SnapShotContentsButton
            source={source}
            variant="overlay"
            className="pointer-events-auto"
          />
        </div>
        <div className="truncate text-[9px] leading-3.5 text-(--snap-shot-text-muted)">
          {source.windowTitle || "Captured window"}
        </div>
      </div>
    </div>
  );
}
