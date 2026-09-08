/**
 * Picks overlay colors for a SnapShot thumbnail from the pixels the overlay
 * sits on, so the app label reads on any capture in any theme. The scrim
 * extends the image's own bottom band, pushed away from mid-tones so the
 * chosen text color keeps contrast.
 */

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface SnapShotOverlayTone {
  /** Base color of the scrim gradient behind the label. */
  readonly scrim: RgbColor;
  /** Label color, chosen for contrast against the scrim. */
  readonly text: RgbColor;
}

const WHITE: RgbColor = { r: 255, g: 255, b: 255 };
const BLACK: RgbColor = { r: 0, g: 0, b: 0 };
const NEAR_BLACK: RgbColor = { r: 24, g: 24, b: 27 };

/** Luminance at which black and white text have equal WCAG contrast. */
const TEXT_LUMINANCE_THRESHOLD = 0.179;
/** How far the scrim is pushed toward its text's opposite pole. */
const SCRIM_PUSH = 0.35;

/** Fraction of the image height, measured from the bottom, that the overlay covers. */
const SAMPLE_BAND = 0.3;

function relativeLuminance(color: RgbColor): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

function mix(base: RgbColor, toward: RgbColor, amount: number): RgbColor {
  return {
    r: Math.round(base.r + (toward.r - base.r) * amount),
    g: Math.round(base.g + (toward.g - base.g) * amount),
    b: Math.round(base.b + (toward.b - base.b) * amount),
  };
}

export function snapShotOverlayTone(sampled: RgbColor): SnapShotOverlayTone {
  const dark = relativeLuminance(sampled) < TEXT_LUMINANCE_THRESHOLD;
  return dark
    ? { scrim: mix(sampled, BLACK, SCRIM_PUSH), text: WHITE }
    : { scrim: mix(sampled, WHITE, SCRIM_PUSH), text: NEAR_BLACK };
}

/** Alpha-weighted mean of RGBA pixels; null when every pixel is transparent. */
export function averageOpaqueColor(pixels: Uint8ClampedArray): RgbColor | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255;
    if (alpha === 0) continue;
    r += pixels[index]! * alpha;
    g += pixels[index + 1]! * alpha;
    b += pixels[index + 2]! * alpha;
    weight += alpha;
  }
  if (weight === 0) return null;
  return { r: Math.round(r / weight), g: Math.round(g / weight), b: Math.round(b / weight) };
}

export function rgbCss(color: RgbColor, alpha?: number): string {
  return alpha === undefined
    ? `rgb(${color.r} ${color.g} ${color.b})`
    : `rgb(${color.r} ${color.g} ${color.b} / ${alpha})`;
}

const SAMPLE_WIDTH = 16;
const SAMPLE_HEIGHT = 4;
const CACHE_LIMIT = 256;
const sampleCache = new Map<string, Promise<RgbColor | null>>();

function readBottomBand(image: HTMLImageElement): RgbColor | null {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (width === 0 || height === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  const bandHeight = Math.max(1, Math.round(height * SAMPLE_BAND));
  // Drawing the band into a tiny canvas lets the rasterizer do the averaging.
  context.drawImage(
    image,
    0,
    height - bandHeight,
    width,
    bandHeight,
    0,
    0,
    SAMPLE_WIDTH,
    SAMPLE_HEIGHT,
  );
  try {
    return averageOpaqueColor(context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data);
  } catch {
    // A tainted canvas (asset served without CORS headers) throws here.
    return null;
  }
}

/**
 * Average color of the image's bottom band, or null when the image cannot be
 * loaded or read. Results are memoized per URL so the three surfaces that
 * show the same capture decode it once.
 */
export function sampleSnapShotBottomColor(src: string): Promise<RgbColor | null> {
  const cached = sampleCache.get(src);
  if (cached) return cached;
  const pending = new Promise<RgbColor | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.addEventListener("load", () => resolve(readBottomBand(image)), { once: true });
    image.addEventListener("error", () => resolve(null), { once: true });
    image.src = src;
  });
  if (sampleCache.size >= CACHE_LIMIT) {
    const oldest = sampleCache.keys().next().value;
    if (oldest !== undefined) sampleCache.delete(oldest);
  }
  sampleCache.set(src, pending);
  return pending;
}
