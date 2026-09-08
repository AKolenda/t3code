import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
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
  clickZoomScale,
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
 * Safari reports trackpad pinch as gesture events instead of ctrl+wheel.
 * Apple documents `clientX` and `clientY` on them, but they are not in any
 * standard, so callers must be ready for them to be missing.
 */
interface SafariGestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX?: number;
  readonly clientY?: number;
}

/**
 * The screenshot with the zoom model of a native image viewer: pinch or
 * ctrl+wheel zooms around the pointer, two-finger scroll or drag pans, and a
 * click toggles between fitted and actual size. Gestures are read from the
 * whole dialog so the pointer does not have to sit on the image. Only the
 * transform changes while zooming, so Chromium keeps the work on the
 * compositor and never repaints the bitmap.
 */
function ZoomableImage({
  src,
  alt,
  surfaceRef,
  onError,
}: {
  readonly src: string;
  readonly alt: string;
  /** The dialog element that receives pinch and wheel gestures. */
  readonly surfaceRef: RefObject<HTMLElement | null>;
  readonly onError: () => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState<ImageZoomState>(IMAGE_ZOOM_IDENTITY);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  // Wheel and gesture listeners must be non-passive to stop the page from
  // scrolling and the browser from zooming the whole window. React registers
  // wheel as passive, so attach them by hand.
  useEffect(() => {
    const surface = surfaceRef.current;
    const image = imageRef.current;
    if (!surface || !image) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const lineScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      if (event.ctrlKey) {
        // Chromium and Firefox report a trackpad pinch as ctrl+wheel.
        const factor = wheelZoomFactor(event.deltaY * lineScale);
        setZoom((current) => {
          const frame = zoomFrame(image, current);
          return zoomImageAt(current, factor, zoomAnchor(frame, event), frame);
        });
        return;
      }
      // A plain two-finger scroll pans the zoomed image, like a native viewer.
      const dx = -event.deltaX * lineScale;
      const dy = -event.deltaY * lineScale;
      setZoom((current) => panImage(current, dx, dy, zoomFrame(image, current)));
    };
    // The last pointer position over the dialog, for gesture events that
    // arrive without coordinates of their own.
    let pointer = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };
    const onPointerMove = (event: PointerEvent) => {
      pointer = { clientX: event.clientX, clientY: event.clientY };
    };
    // Safari's `scale` is cumulative from the start of the gesture.
    let gestureStartScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      setZoom((current) => {
        gestureStartScale = current.scale;
        return current;
      });
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as SafariGestureEvent;
      const at =
        Number.isFinite(gesture.clientX) && Number.isFinite(gesture.clientY)
          ? { clientX: gesture.clientX as number, clientY: gesture.clientY as number }
          : pointer;
      setZoom((current) => {
        const frame = zoomFrame(image, current);
        const factor = (gestureStartScale * gesture.scale) / current.scale;
        return zoomImageAt(current, factor, zoomAnchor(frame, at), frame);
      });
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("pointermove", onPointerMove, { passive: true });
    surface.addEventListener("gesturestart", onGestureStart, { passive: false });
    surface.addEventListener("gesturechange", onGestureChange, { passive: false });
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("gesturestart", onGestureStart);
      surface.removeEventListener("gesturechange", onGestureChange);
    };
  }, [surfaceRef]);

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
      className={`max-h-[86vh] max-w-[92vw] animate-[snap-shot-contents-enter_140ms_ease-out] touch-none select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl motion-reduce:animate-none ${
        zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
      }`}
      style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
      draggable={false}
      onError={onError}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        if (zoomed) event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        // A few pixels of jitter during a click still count as a click.
        if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 4) {
          drag.moved = true;
        }
        if (!zoomed) return;
        const image = event.currentTarget;
        setZoom((current) => panImage(current, dx, dy, zoomFrame(image, current)));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (drag?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        // A drag that moved is a pan, not a click.
        if (drag.moved) return;
        const image = event.currentTarget;
        setZoom((current) => {
          if (current.scale > 1) return IMAGE_ZOOM_IDENTITY;
          const frame = zoomFrame(image, current);
          const scale = clickZoomScale(image.naturalWidth, image.offsetWidth);
          return zoomImageAt(current, scale, zoomAnchor(frame, event), frame);
        });
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    />
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
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
      ref={surfaceRef}
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
              surfaceRef={surfaceRef}
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
