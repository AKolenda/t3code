import { useEffect, useRef, type RefObject } from "react";

import {
  clickZoomScale,
  IMAGE_ZOOM_IDENTITY,
  imageZoomLayout,
  resizeImageZoom,
  type ImageZoomFrame,
  type ImageZoomState,
  wheelZoomFactor,
  zoomImageAt,
} from "./imageZoom";

/**
 * The browser owns scrolling, including trackpad momentum and diagonal pans.
 * Pinch changes the image transform and scroll bounds without a React render.
 */
export function ZoomableImage({
  src,
  alt,
  surfaceRef,
  onError,
  onClose,
}: {
  readonly src: string;
  readonly alt: string;
  readonly surfaceRef: RefObject<HTMLElement | null>;
  readonly onError: () => void;
  readonly onClose: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const image = imageRef.current;
    if (!surface || !viewport || !content || !image) return;

    let scale = 1;
    let frame: ImageZoomFrame | undefined;
    let pointer = { x: 0, y: 0 };
    let gestureScale = 1;
    let drag: {
      pointerId: number;
      x: number;
      y: number;
      startX: number;
      startY: number;
      moved: boolean;
    } | null = null;

    const currentState = (): ImageZoomState => ({
      scale,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    });

    const renderZoom = (state: ImageZoomState) => {
      if (!frame) return;
      const layout = imageZoomLayout(frame, state.scale);
      scale = state.scale;
      content.style.width = `${layout.contentWidth}px`;
      content.style.height = `${layout.contentHeight}px`;
      image.style.width = `${frame.width}px`;
      image.style.height = `${frame.height}px`;
      image.style.transform = `translate(${layout.left}px, ${layout.top}px) scale(${scale})`;
      image.style.cursor = scale > 1 ? "grab" : "zoom-in";
      image.style.visibility = "visible";
      viewport.scrollTo({ left: state.scrollLeft, top: state.scrollTop, behavior: "instant" });
    };

    const resize = () => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const viewportWidth = viewport.clientWidth;
      const viewportHeight = viewport.clientHeight;
      if (!viewportWidth || !viewportHeight) return;
      const fit = Math.min(
        1,
        viewportWidth / image.naturalWidth,
        viewportHeight / image.naturalHeight,
      );
      const nextFrame = {
        width: image.naturalWidth * fit,
        height: image.naturalHeight * fit,
        viewportWidth,
        viewportHeight,
      };
      const state = frame ? resizeImageZoom(currentState(), frame, nextFrame) : IMAGE_ZOOM_IDENTITY;
      frame = nextFrame;
      renderZoom(state);
    };

    const anchorAt = (event: { clientX: number; clientY: number }) => {
      const rect = viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const zoomAt = (factor: number, anchor: { x: number; y: number }) => {
      if (!frame) return;
      const state = currentState();
      const next = zoomImageAt(state, factor, anchor, frame);
      if (next !== state) renderZoom(next);
    };
    const onWheel = (event: WheelEvent) => {
      // Leave ordinary wheel events to the scroll area. Canceling them loses
      // the browser's scroll handling and routes every pan through JavaScript.
      if (!event.ctrlKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      zoomAt(wheelZoomFactor(event.deltaY * unit), anchorAt(event));
    };
    const onPointerMove = (event: PointerEvent) => {
      pointer = anchorAt(event);
    };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (!("scale" in event) || typeof event.scale !== "number" || !(event.scale > 0)) return;
      const anchor =
        "clientX" in event &&
        typeof event.clientX === "number" &&
        Number.isFinite(event.clientX) &&
        "clientY" in event &&
        typeof event.clientY === "number" &&
        Number.isFinite(event.clientY)
          ? anchorAt({ clientX: event.clientX, clientY: event.clientY })
          : pointer;
      zoomAt(event.scale / gestureScale, anchor);
      // Use consecutive samples so reversing a pinch responds immediately,
      // even after the gesture has passed the minimum or maximum zoom.
      gestureScale = event.scale;
    };
    const onGestureEnd = (event: Event) => event.preventDefault();

    const clearDrag = () => {
      drag = null;
      image.style.cursor = scale > 1 ? "grab" : "zoom-in";
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      image.setPointerCapture(event.pointerId);
      if (scale > 1) image.style.cursor = "grabbing";
    };
    const onDrag = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) {
        clearDrag();
        return;
      }
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4)
        drag.moved = true;
      if (!drag.moved) return;
      viewport.scrollBy({
        left: drag.x - event.clientX,
        top: drag.y - event.clientY,
        behavior: "instant",
      });
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const wasClick = !drag.moved;
      clearDrag();
      if (!wasClick || !frame) return;
      if (scale > 1) renderZoom(IMAGE_ZOOM_IDENTITY);
      else zoomAt(clickZoomScale(image.naturalWidth, frame.width), anchorAt(event));
    };

    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    image.addEventListener("load", resize);
    resize();
    pointer = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("pointermove", onPointerMove, { passive: true });
    surface.addEventListener("gesturestart", onGestureStart, { passive: false });
    surface.addEventListener("gesturechange", onGestureChange, { passive: false });
    surface.addEventListener("gestureend", onGestureEnd, { passive: false });
    image.addEventListener("pointerdown", onPointerDown);
    image.addEventListener("pointermove", onDrag);
    image.addEventListener("pointerup", onPointerUp);
    image.addEventListener("pointercancel", clearDrag);
    image.addEventListener("lostpointercapture", clearDrag);
    window.addEventListener("blur", clearDrag);
    return () => {
      observer.disconnect();
      image.removeEventListener("load", resize);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("gesturestart", onGestureStart);
      surface.removeEventListener("gesturechange", onGestureChange);
      surface.removeEventListener("gestureend", onGestureEnd);
      image.removeEventListener("pointerdown", onPointerDown);
      image.removeEventListener("pointermove", onDrag);
      image.removeEventListener("pointerup", onPointerUp);
      image.removeEventListener("pointercancel", clearDrag);
      image.removeEventListener("lostpointercapture", clearDrag);
      window.removeEventListener("blur", clearDrag);
    };
  }, [surfaceRef]);

  return (
    <div
      ref={viewportRef}
      className="h-[86vh] w-[92vw] overflow-auto overscroll-contain [overflow-anchor:none] [scrollbar-width:none]"
      onClick={(event) => {
        if (event.target === viewportRef.current || event.target === contentRef.current) onClose();
      }}
    >
      <div ref={contentRef} className="relative">
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          className="invisible absolute left-0 top-0 max-w-none origin-top-left select-none rounded-lg border border-border/70 bg-background shadow-2xl"
          draggable={false}
          onError={onError}
        />
      </div>
    </div>
  );
}
