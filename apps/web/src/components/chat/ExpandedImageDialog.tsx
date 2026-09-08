import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon, ImageIcon, TextIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import {
  SnapShotAccessibilityData,
  SnapShotContentsButton,
  snapShotAccessibilityDetails,
} from "./SnapShotAttachmentDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  clampImagePan,
  DOUBLE_CLICK_IMAGE_ZOOM,
  IMAGE_ZOOM_IDENTITY,
  type ImageZoomFrame,
  type ImageZoomState,
  panImage,
  wheelZoomFactor,
  zoomImageAt,
} from "./imageZoom";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(92vw,32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

function ExpandedMediaFailure({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
      {children}
    </div>
  );
}

function ExpandedVideo({ item }: { readonly item: ExpandedImageItem }) {
  const asset = item.actionsSource?.asset;
  const assetUrl = useAssetUrlState(asset?.environmentId ?? null, asset?.resource ?? null);
  const refreshAssetUrl = useAssetUrlRefresh(asset?.environmentId ?? null, asset?.resource ?? null);
  const src = asset
    ? assetUrl._tag === "Success"
      ? assetUrl.url + (item.srcFragment ?? "")
      : null
    : item.src;
  return (
    <MediaVideoPlayer
      src={src}
      label={item.name}
      sourceFailed={assetUrl._tag === "Failure"}
      originalUrl={item.originalUrl}
      preload="metadata"
      autoPlay={item.autoPlay ?? true}
      className="block max-h-[86vh] max-w-[92vw] text-center"
      videoClassName="aspect-auto max-h-[86vh] w-auto max-w-[92vw] rounded-lg border border-border/70 shadow-2xl"
      stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
      onRetry={asset ? refreshAssetUrl : undefined}
    />
  );
}

function zoomFrame(image: HTMLImageElement, zoom: ImageZoomState): ImageZoomFrame {
  // The rect is already transformed. Scaling around the center leaves the
  // center put, so subtracting the translate gives the untransformed center.
  const rect = image.getBoundingClientRect();
  return {
    width: image.offsetWidth,
    height: image.offsetHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    centerX: rect.left + rect.width / 2 - zoom.x - window.innerWidth / 2,
    centerY: rect.top + rect.height / 2 - zoom.y - window.innerHeight / 2,
  };
}

/** Pointer position relative to the untransformed center of the image box. */
function zoomAnchor(frame: ImageZoomFrame, event: { clientX: number; clientY: number }) {
  return {
    x: event.clientX - frame.viewportWidth / 2 - frame.centerX,
    y: event.clientY - frame.viewportHeight / 2 - frame.centerY,
  };
}

/**
 * The screenshot with pinch, wheel and double-click zoom plus drag to pan.
 * Only the transform changes while zooming, so Chromium keeps the work on the
 * compositor and never repaints the bitmap.
 */
function ZoomableImage({
  src,
  alt,
  onError,
}: {
  readonly src: string;
  readonly alt: string;
  readonly onError: () => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState<ImageZoomState>(IMAGE_ZOOM_IDENTITY);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  // Wheel must be non-passive to stop the page from scrolling or, in the
  // desktop app, from zooming the whole window. React registers wheel as
  // passive, so attach it by hand.
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // macOS reports trackpad pinch as ctrl+wheel with small deltas. A plain
      // wheel zooms too, since the dialog has nothing else to scroll.
      const factor = wheelZoomFactor(event.ctrlKey ? event.deltaY * 3 : event.deltaY);
      setZoom((current) => {
        const frame = zoomFrame(image, current);
        return zoomImageAt(current, factor, zoomAnchor(frame, event), frame);
      });
    };
    image.addEventListener("wheel", onWheel, { passive: false });
    return () => image.removeEventListener("wheel", onWheel);
  }, []);

  // A resize changes the pan bounds. Reclamp so a grown window does not leave
  // the image offset with backdrop showing at one edge.
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const onResize = () => setZoom((current) => clampImagePan(current, zoomFrame(image, current)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const zoomed = zoom.scale > 1;
  return (
    <img
      ref={imageRef}
      src={src}
      alt={alt}
      className={`max-h-[86vh] max-w-[92vw] animate-[snap-shot-contents-enter_140ms_ease-out] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl motion-reduce:animate-none ${
        zoomed ? "cursor-grab touch-none active:cursor-grabbing" : "cursor-zoom-in"
      }`}
      style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
      draggable={false}
      onError={onError}
      onPointerDown={(event) => {
        if (!zoomed || event.button !== 0) return;
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        const image = event.currentTarget;
        setZoom((current) => panImage(current, dx, dy, zoomFrame(image, current)));
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      onDoubleClick={(event) => {
        const image = event.currentTarget;
        setZoom((current) => {
          if (current.scale > 1) return IMAGE_ZOOM_IDENTITY;
          const frame = zoomFrame(image, current);
          return zoomImageAt(current, DOUBLE_CLICK_IMAGE_ZOOM, zoomAnchor(frame, event), frame);
        });
      }}
    />
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [accessibilityDetailsSrc, setAccessibilityDetailsSrc] = useState<string | null>(null);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;
  const item = preview.images[index];
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const openFile = source.onOpenFile;
  const actionsSource: MediaActionSource = openFile
    ? {
        ...source,
        onOpenFile: () => {
          openFile();
          onClose();
        },
      }
    : source;

  const navigateImage = useCallback(
    (direction: -1 | 1) => {
      setImageOffset(
        (current) => (current + direction + preview.images.length) % preview.images.length,
      );
    },
    [preview.images.length],
  );

  // The element that opened the preview gets focus back on close. Without
  // this a close button click leaves focus on the unmounted dialog, and the
  // composer that owned the opener reads that as a blur and rests.
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isContextMenuOpen()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;
  const accessibilityDetails = item.source ? snapShotAccessibilityDetails(item.source) : undefined;
  const showingAccessibilityDetails =
    Boolean(accessibilityDetails) && accessibilityDetailsSrc === item.src;
  const contentsLabel = showingAccessibilityDetails
    ? "Show screenshot"
    : accessibilityDetails?.format === "json"
      ? "Show accessibility JSON"
      : "Show extracted text";
  const ContentsIcon = showingAccessibilityDetails ? ImageIcon : TextIcon;

  return createPortal(
    <div
      {...composerFloatingLayerProps}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label={`Expanded ${mediaLabel} preview`}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label={`Close ${mediaLabel} preview`}
        onClick={onClose}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon-xl"
          variant="overlay"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-7" />
        </Button>
      )}
      <MediaActions source={actionsSource}>
        <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="absolute right-2 top-2 z-20"
            onClick={onClose}
            aria-label={`Close ${mediaLabel} preview`}
          >
            <XIcon />
          </Button>
          {item.type === "video" ? (
            <ExpandedVideo key={index} item={item} />
          ) : showingAccessibilityDetails ? (
            accessibilityDetails ? (
              <SnapShotAccessibilityData
                details={accessibilityDetails}
                className="h-[min(86vh,40rem)] w-[min(92vw,42rem)] animate-[snap-shot-contents-enter_140ms_ease-out] rounded-lg border border-border/70 bg-background p-4 text-xs leading-5 shadow-2xl motion-reduce:animate-none"
              />
            ) : null
          ) : item.src === null || failedImageSrc === item.src ? (
            <ExpandedMediaFailure>
              <p>
                {openOriginalLink
                  ? "This image could not be loaded."
                  : "Image unavailable. The file may have been moved or deleted."}
              </p>
              {openOriginalLink}
            </ExpandedMediaFailure>
          ) : (
            <ZoomableImage
              // A new image starts unzoomed with its own wheel listener.
              key={item.src}
              src={item.src}
              alt={item.name}
              onError={() => setFailedImageSrc(item.src)}
            />
          )}
          <div className="mt-2 flex max-w-[92vw] items-center justify-center gap-1.5 text-xs text-white/80">
            <span className="truncate">
              {item.name}
              {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
            </span>
            {accessibilityDetails && item.source ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={contentsLabel}
                      aria-pressed={showingAccessibilityDetails}
                      className="[--control-icon-color:currentColor] hover:bg-white/10 hover:text-white"
                      onClick={() =>
                        setAccessibilityDetailsSrc(showingAccessibilityDetails ? null : item.src)
                      }
                      size="icon-micro"
                      variant="ghost-muted"
                    />
                  }
                >
                  <ContentsIcon className="size-3" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup side="top">{contentsLabel}</TooltipPopup>
              </Tooltip>
            ) : item.source ? (
              <SnapShotContentsButton
                source={item.source}
                side="top"
                className="hover:bg-white/10 hover:text-white"
              />
            ) : null}
          </div>
        </div>
      </MediaActions>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon-xl"
          variant="overlay"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-7" />
        </Button>
      )}
    </div>,
    document.body,
  );
});
