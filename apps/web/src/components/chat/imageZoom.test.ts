import { describe, expect, it } from "vite-plus/test";

import {
  clampImagePan,
  IMAGE_ZOOM_IDENTITY,
  MAX_IMAGE_ZOOM,
  panImage,
  wheelZoomFactor,
  zoomImageAt,
} from "./imageZoom";

const frame = {
  width: 400,
  height: 300,
  viewportWidth: 1000,
  viewportHeight: 800,
  centerX: 0,
  centerY: 0,
};

describe("zoomImageAt", () => {
  it("keeps the anchored point fixed on screen", () => {
    const anchor = { x: 100, y: -50 };
    // 4x overflows the viewport on both axes, so the clamp leaves room to
    // keep the anchor fixed. The image point under the anchor before the zoom
    // is `anchor` itself, and after the zoom it renders at x + scale * anchor.
    const zoomed = zoomImageAt(IMAGE_ZOOM_IDENTITY, 4, anchor, frame);
    expect(zoomed.scale).toBe(4);
    expect(zoomed.x + zoomed.scale * anchor.x).toBeCloseTo(anchor.x);
    expect(zoomed.y + zoomed.scale * anchor.y).toBeCloseTo(anchor.y);
  });

  it("recenters when the zoomed image still fits the viewport", () => {
    expect(zoomImageAt(IMAGE_ZOOM_IDENTITY, 2, { x: 100, y: 100 }, frame)).toEqual({
      scale: 2,
      x: 0,
      y: 0,
    });
  });

  it("clamps the scale and returns the same state when nothing changes", () => {
    const max = zoomImageAt(IMAGE_ZOOM_IDENTITY, 100, { x: 0, y: 0 }, frame);
    expect(max.scale).toBe(MAX_IMAGE_ZOOM);
    expect(zoomImageAt(max, 2, { x: 0, y: 0 }, frame)).toBe(max);
    expect(zoomImageAt(IMAGE_ZOOM_IDENTITY, 0.5, { x: 0, y: 0 }, frame)).toBe(IMAGE_ZOOM_IDENTITY);
  });

  it("recenters when zooming back out to 1x", () => {
    const zoomed = zoomImageAt(IMAGE_ZOOM_IDENTITY, 4, { x: 150, y: 100 }, frame);
    expect(zoomImageAt(zoomed, 0.25, { x: 0, y: 0 }, frame)).toEqual(IMAGE_ZOOM_IDENTITY);
  });
});

describe("clampImagePan", () => {
  it("centers an axis where the image still fits the viewport", () => {
    expect(clampImagePan({ scale: 2, x: 300, y: 200 }, frame)).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it("stops the far edge at the viewport edge once the image overflows", () => {
    // 400 * 4 = 1600 wide in a 1000 viewport leaves 300 of slack per side.
    expect(clampImagePan({ scale: 4, x: 900, y: -900 }, frame)).toEqual({
      scale: 4,
      x: 300,
      y: -200,
    });
  });

  it("shifts the bounds by the image center offset so the viewport stays covered", () => {
    // The caption sits the image 12px above the viewport center. Dragging down
    // must stop 12px earlier and dragging up may go 12px further.
    const offset = { ...frame, centerY: -12 };
    expect(clampImagePan({ scale: 4, x: 0, y: 900 }, offset).y).toBe(212);
    expect(clampImagePan({ scale: 4, x: 0, y: -900 }, offset).y).toBe(-188);
  });
});

describe("panImage", () => {
  it("ignores pans at 1x", () => {
    expect(panImage(IMAGE_ZOOM_IDENTITY, 40, 40, frame)).toBe(IMAGE_ZOOM_IDENTITY);
  });

  it("moves a zoomed image within the clamp", () => {
    expect(panImage({ scale: 4, x: 0, y: 0 }, -100, 50, frame)).toEqual({
      scale: 4,
      x: -100,
      y: 50,
    });
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on negative deltas and caps a mouse notch", () => {
    expect(wheelZoomFactor(-5)).toBeGreaterThan(1);
    expect(wheelZoomFactor(5)).toBeLessThan(1);
    expect(wheelZoomFactor(-100)).toBe(wheelZoomFactor(-50));
  });
});
