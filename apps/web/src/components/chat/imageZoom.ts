/**
 * Pure zoom and pan math for the expanded image dialog. The image keeps its
 * layout box and is scaled around its center with a CSS transform, so `x` and
 * `y` are the translate applied after scaling, in CSS pixels.
 */
export interface ImageZoomState {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** The untransformed image size and the viewport it must stay visible in. */
export interface ImageZoomFrame {
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const IMAGE_ZOOM_IDENTITY: ImageZoomState = { scale: 1, x: 0, y: 0 };
export const MIN_IMAGE_ZOOM = 1;
export const MAX_IMAGE_ZOOM = 8;
/** Zoom applied by a double click on an unzoomed image. */
export const DOUBLE_CLICK_IMAGE_ZOOM = 2.5;

function clampAxis(translate: number, scaledSize: number, viewportSize: number): number {
  // An image that fits on this axis stays centered. One that overflows may be
  // panned until its far edge meets the viewport edge, never past it.
  const overflow = Math.max(0, (scaledSize - viewportSize) / 2);
  // `|| 0` turns a -0 from clamping into 0 so identity states compare equal.
  return Math.min(overflow, Math.max(-overflow, translate)) || 0;
}

export function clampImagePan(state: ImageZoomState, frame: ImageZoomFrame): ImageZoomState {
  return {
    scale: state.scale,
    x: clampAxis(state.x, frame.width * state.scale, frame.viewportWidth),
    y: clampAxis(state.y, frame.height * state.scale, frame.viewportHeight),
  };
}

/**
 * Multiplies the scale by `factor` while keeping `anchor` fixed on screen.
 * `anchor` is the pointer position relative to the untransformed image center.
 */
export function zoomImageAt(
  state: ImageZoomState,
  factor: number,
  anchor: Point,
  frame: ImageZoomFrame,
): ImageZoomState {
  const scale = Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, state.scale * factor));
  if (scale === state.scale) return state;
  const ratio = scale / state.scale;
  return clampImagePan(
    {
      scale,
      x: anchor.x - ratio * (anchor.x - state.x),
      y: anchor.y - ratio * (anchor.y - state.y),
    },
    frame,
  );
}

export function panImage(
  state: ImageZoomState,
  dx: number,
  dy: number,
  frame: ImageZoomFrame,
): ImageZoomState {
  if (state.scale <= MIN_IMAGE_ZOOM) return state;
  return clampImagePan({ scale: state.scale, x: state.x + dx, y: state.y + dy }, frame);
}

/**
 * Converts a wheel delta into a zoom factor. Trackpad pinch on macOS arrives
 * as ctrl+wheel with small deltas, mouse wheels send about 100 per notch, so
 * the delta is capped to keep a notch from jumping more than about 1.6x.
 */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-Math.max(-50, Math.min(50, deltaY)) * 0.01);
}
