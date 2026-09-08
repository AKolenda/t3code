/** Image scale and the browser's scroll position, in CSS pixels. */
export interface ImageZoomState {
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

export interface ImageZoomFrame {
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

export const IMAGE_ZOOM_IDENTITY: ImageZoomState = { scale: 1, scrollLeft: 0, scrollTop: 0 };
export const MAX_IMAGE_ZOOM = 8;

/** Centers each image axis until it is large enough to scroll. */
export function imageZoomLayout(frame: ImageZoomFrame, scale: number) {
  const width = frame.width * scale;
  const height = frame.height * scale;
  return {
    width,
    height,
    left: Math.max(0, (frame.viewportWidth - width) / 2),
    top: Math.max(0, (frame.viewportHeight - height) / 2),
    contentWidth: Math.max(frame.viewportWidth, width),
    contentHeight: Math.max(frame.viewportHeight, height),
  };
}

function imagePointAt(state: ImageZoomState, frame: ImageZoomFrame, anchor: Point) {
  const layout = imageZoomLayout(frame, state.scale);
  return {
    x: (state.scrollLeft + anchor.x - layout.left) / layout.width,
    y: (state.scrollTop + anchor.y - layout.top) / layout.height,
  };
}

function scrollToImagePoint(
  point: Point,
  anchor: Point,
  scale: number,
  frame: ImageZoomFrame,
): ImageZoomState {
  const layout = imageZoomLayout(frame, scale);
  return {
    scale,
    scrollLeft: Math.max(
      0,
      Math.min(
        layout.contentWidth - frame.viewportWidth,
        point.x * layout.width + layout.left - anchor.x,
      ),
    ),
    scrollTop: Math.max(
      0,
      Math.min(
        layout.contentHeight - frame.viewportHeight,
        point.y * layout.height + layout.top - anchor.y,
      ),
    ),
  };
}

/** Keeps the image point under the pointer fixed as the scroll area changes size. */
export function zoomImageAt(
  state: ImageZoomState,
  factor: number,
  anchor: Point,
  frame: ImageZoomFrame,
): ImageZoomState {
  const scale = Math.min(MAX_IMAGE_ZOOM, Math.max(1, state.scale * factor));
  if (scale === state.scale) return state;
  return scrollToImagePoint(imagePointAt(state, frame, anchor), anchor, scale, frame);
}

/** Keeps the viewport centered on the same part of the image after a resize. */
export function resizeImageZoom(
  state: ImageZoomState,
  previousFrame: ImageZoomFrame,
  frame: ImageZoomFrame,
): ImageZoomState {
  const point = imagePointAt(state, previousFrame, {
    x: previousFrame.viewportWidth / 2,
    y: previousFrame.viewportHeight / 2,
  });
  return scrollToImagePoint(
    point,
    { x: frame.viewportWidth / 2, y: frame.viewportHeight / 2 },
    state.scale,
    frame,
  );
}

/** Chromium encodes trackpad pinch as deltaY = -100 * log(scale). */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY / 100);
}

/** A click shows actual pixels, or enlarges an image that already fits at actual size. */
export function clickZoomScale(naturalWidth: number, displayedWidth: number): number {
  if (naturalWidth <= 0 || displayedWidth <= 0) return 2;
  return Math.min(MAX_IMAGE_ZOOM, Math.max(2, naturalWidth / displayedWidth));
}
