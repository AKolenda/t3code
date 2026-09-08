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

/**
 * The untransformed image size, the viewport it must stay visible in, and the
 * offset of the untransformed image center from the viewport center. The
 * caption below the image pushes the image above the viewport center, so the
 * pan bounds are not symmetric.
 */
export interface ImageZoomFrame {
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly centerX: number;
  readonly centerY: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const IMAGE_ZOOM_IDENTITY: ImageZoomState = { scale: 1, x: 0, y: 0 };
const MIN_IMAGE_ZOOM = 1;
export const MAX_IMAGE_ZOOM = 8;

function clampAxis(
  translate: number,
  scaledSize: number,
  viewportSize: number,
  center: number,
): number {
  // An image that fits on this axis keeps its layout position. One that
  // overflows may be panned until its far edge meets the viewport edge, never
  // past it, so it always covers the viewport on this axis.
  if (scaledSize <= viewportSize) return 0;
  const overflow = (scaledSize - viewportSize) / 2;
  // `|| 0` turns a -0 from clamping into 0 so identity states compare equal.
  return Math.min(overflow - center, Math.max(-overflow - center, translate)) || 0;
}

export function clampImagePan(state: ImageZoomState, frame: ImageZoomFrame): ImageZoomState {
  return {
    scale: state.scale,
    x: clampAxis(state.x, frame.width * state.scale, frame.viewportWidth, frame.centerX),
    y: clampAxis(state.y, frame.height * state.scale, frame.viewportHeight, frame.centerY),
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
 * Converts a ctrl+wheel delta into a zoom factor. Chromium reports a trackpad
 * pinch as ctrl+wheel where `1 - deltaY / 100` is the scale change, so this
 * matches the native pinch rate. A mouse wheel with ctrl sends about 100 per
 * notch, so the delta is capped to keep a notch near a 1.3x step.
 */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-Math.max(-25, Math.min(25, deltaY)) * 0.01);
}

/**
 * The scale a click zooms to from the fitted size: the image's actual pixel
 * size, or 2x when the image is already shown at or near its actual size.
 */
export function clickZoomScale(naturalWidth: number, displayedWidth: number): number {
  if (naturalWidth <= 0 || displayedWidth <= 0) return 2;
  return Math.max(2, naturalWidth / displayedWidth);
}
