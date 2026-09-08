import { describe, expect, it } from "vite-plus/test";

import {
  clickZoomScale,
  IMAGE_ZOOM_IDENTITY,
  imageZoomLayout,
  MAX_IMAGE_ZOOM,
  resizeImageZoom,
  wheelZoomFactor,
  zoomImageAt,
} from "./imageZoom";

const frame = { width: 1000, height: 600, viewportWidth: 1000, viewportHeight: 800 };

function imagePoint(
  state: typeof IMAGE_ZOOM_IDENTITY,
  anchor: { x: number; y: number },
  imageFrame = frame,
) {
  const layout = imageZoomLayout(imageFrame, state.scale);
  return {
    x: (state.scrollLeft + anchor.x - layout.left) / layout.width,
    y: (state.scrollTop + anchor.y - layout.top) / layout.height,
  };
}

describe("zoomImageAt", () => {
  it("keeps the image point under the pointer when the centered image starts overflowing", () => {
    const anchor = { x: 600, y: 300 };
    const zoomed = zoomImageAt(IMAGE_ZOOM_IDENTITY, 2, anchor, frame);
    expect(zoomed).toEqual({ scale: 2, scrollLeft: 600, scrollTop: 100 });
    expect(imagePoint(zoomed, anchor)).toEqual(imagePoint(IMAGE_ZOOM_IDENTITY, anchor));
  });

  it("anchors a pinch to the browser's latest diagonal scroll position", () => {
    const scrolled = { scale: 3, scrollLeft: 940, scrollTop: 370 };
    const anchor = { x: 230, y: 510 };
    const zoomed = zoomImageAt(scrolled, 1.2, anchor, frame);
    const before = imagePoint(scrolled, anchor);
    const after = imagePoint(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("centers an image that still fits on one axis", () => {
    const narrow = { ...frame, width: 200, height: 600 };
    const zoomed = zoomImageAt(IMAGE_ZOOM_IDENTITY, 2, { x: 500, y: 400 }, narrow);
    expect(zoomed).toEqual({ scale: 2, scrollLeft: 0, scrollTop: 200 });
    expect(imageZoomLayout(narrow, 2).left).toBe(300);
  });

  it("clamps scroll offsets to the resized content at both edges", () => {
    const atEnd = { scale: 4, scrollLeft: 3000, scrollTop: 1600 };
    const zoomed = zoomImageAt(atEnd, 0.5, { x: 0, y: 0 }, frame);
    expect(zoomed).toEqual({ scale: 2, scrollLeft: 1000, scrollTop: 400 });
    expect(zoomImageAt(IMAGE_ZOOM_IDENTITY, 2, { x: -50, y: -50 }, frame)).toEqual({
      scale: 2,
      scrollLeft: 0,
      scrollTop: 0,
    });
  });

  it("returns to fitted size without a residual scroll offset", () => {
    expect(
      zoomImageAt({ scale: 4, scrollLeft: 1000, scrollTop: 600 }, 0.1, { x: 300, y: 400 }, frame),
    ).toEqual(IMAGE_ZOOM_IDENTITY);
  });

  it("limits zoom and allows the next reverse sample to move away from the limit", () => {
    const anchor = { x: 500, y: 400 };
    const max = zoomImageAt(IMAGE_ZOOM_IDENTITY, 100, anchor, frame);
    expect(max.scale).toBe(MAX_IMAGE_ZOOM);
    expect(zoomImageAt(max, 2, anchor, frame)).toBe(max);
    expect(zoomImageAt(max, 0.9, anchor, frame).scale).toBeCloseTo(7.2);
    expect(zoomImageAt(IMAGE_ZOOM_IDENTITY, 0.5, anchor, frame)).toBe(IMAGE_ZOOM_IDENTITY);
  });
});

describe("resizeImageZoom", () => {
  it("keeps the same image point at the center of a resized viewport", () => {
    const state = { scale: 3, scrollLeft: 940, scrollTop: 370 };
    const resizedFrame = { width: 800, height: 480, viewportWidth: 800, viewportHeight: 600 };
    const resized = resizeImageZoom(state, frame, resizedFrame);
    const before = imagePoint(state, { x: 500, y: 400 });
    const after = imagePoint(resized, { x: 400, y: 300 }, resizedFrame);
    expect(resized.scale).toBe(3);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("recenters when the viewport grows beyond the zoomed image", () => {
    const larger = { ...frame, viewportWidth: 3000, viewportHeight: 2000 };
    expect(resizeImageZoom({ scale: 2, scrollLeft: 600, scrollTop: 100 }, frame, larger)).toEqual({
      scale: 2,
      scrollLeft: 0,
      scrollTop: 0,
    });
  });
});

describe("wheelZoomFactor", () => {
  it("recovers Chromium's exact pinch scale, including a fast gesture", () => {
    for (const scale of [0.5, 0.95, 1.05, 1.8, 2]) {
      expect(wheelZoomFactor(-100 * Math.log(scale))).toBeCloseTo(scale);
    }
  });

  it("gives the same zoom for coalesced and separate trackpad samples", () => {
    expect(wheelZoomFactor(-60)).toBeCloseTo(wheelZoomFactor(-20) ** 3);
    expect(wheelZoomFactor(60) * wheelZoomFactor(-60)).toBeCloseTo(1);
  });
});

describe("clickZoomScale", () => {
  it("shows actual pixels for a large image", () => {
    expect(clickZoomScale(3000, 1000)).toBe(3);
  });

  it("enlarges an image that already fits and respects the zoom limit", () => {
    expect(clickZoomScale(1000, 1000)).toBe(2);
    expect(clickZoomScale(0, 1000)).toBe(2);
    expect(clickZoomScale(12000, 1000)).toBe(MAX_IMAGE_ZOOM);
  });
});
