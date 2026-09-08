import { describe, expect, it } from "vite-plus/test";

import {
  averageOpaqueColor,
  coverCrop,
  SNAP_SHOT_FRAME_ASPECT,
  snapShotOverlayTone,
} from "./snapShotOverlayTone";

describe("snapShotOverlayTone", () => {
  it("puts white text on a scrim darker than a dark capture", () => {
    const tone = snapShotOverlayTone({ r: 40, g: 44, b: 52 });
    expect(tone.text).toEqual({ r: 255, g: 255, b: 255 });
    expect(tone.scrim.r).toBeLessThan(40);
    expect(tone.scrim.g).toBeLessThan(44);
    expect(tone.scrim.b).toBeLessThan(52);
  });

  it("puts dark text on a scrim lighter than a light capture", () => {
    const tone = snapShotOverlayTone({ r: 235, g: 236, b: 240 });
    expect(tone.text).toEqual({ r: 24, g: 24, b: 27 });
    expect(tone.scrim.r).toBeGreaterThan(235);
    expect(tone.scrim.g).toBeGreaterThan(236);
    expect(tone.scrim.b).toBeGreaterThan(240);
  });

  it("splits mid-tones at the equal-contrast luminance", () => {
    // Luminance just under 0.179 → white text; just over → dark text.
    expect(snapShotOverlayTone({ r: 117, g: 117, b: 117 }).text.r).toBe(255);
    expect(snapShotOverlayTone({ r: 120, g: 120, b: 120 }).text.r).toBe(24);
  });

  it("keeps the scrim's hue so it extends the image", () => {
    const tone = snapShotOverlayTone({ r: 200, g: 60, b: 60 });
    expect(tone.scrim.r).toBeGreaterThan(tone.scrim.g);
    expect(tone.scrim.g).toEqual(tone.scrim.b);
  });
});

describe("averageOpaqueColor", () => {
  it("weights pixels by alpha and skips transparent ones", () => {
    const pixels = new Uint8ClampedArray([
      // fully opaque black
      0, 0, 0, 255,
      // fully transparent white must not count
      255, 255, 255, 0,
      // half-transparent white counts half
      255, 255, 255, 128,
    ]);
    const color = averageOpaqueColor(pixels);
    expect(color).not.toBeNull();
    // (0*1 + 255*0.502) / 1.502 ≈ 85
    expect(color!.r).toBe(85);
    expect(color!.g).toBe(85);
    expect(color!.b).toBe(85);
  });

  it("returns null for a fully transparent band", () => {
    expect(averageOpaqueColor(new Uint8ClampedArray([1, 2, 3, 0, 4, 5, 6, 0]))).toBeNull();
  });
});

describe("coverCrop", () => {
  it("keeps a frame-shaped image whole", () => {
    expect(coverCrop(520, 280, SNAP_SHOT_FRAME_ASPECT)).toEqual({
      x: 0,
      y: 0,
      width: 520,
      height: 280,
    });
  });

  it("crops the top and bottom of a portrait capture, so the sampled band is mid-image", () => {
    const crop = coverCrop(400, 800, SNAP_SHOT_FRAME_ASPECT);
    expect(crop.x).toBe(0);
    expect(crop.width).toBe(400);
    expect(crop.height).toBeCloseTo(400 / SNAP_SHOT_FRAME_ASPECT);
    expect(crop.y).toBeCloseTo((800 - crop.height) / 2);
    expect(crop.y + crop.height).toBeLessThan(800);
  });

  it("crops the sides of an ultra-wide capture and keeps its full height", () => {
    const crop = coverCrop(3000, 500, SNAP_SHOT_FRAME_ASPECT);
    expect(crop.y).toBe(0);
    expect(crop.height).toBe(500);
    expect(crop.width).toBeCloseTo(500 * SNAP_SHOT_FRAME_ASPECT);
    expect(crop.x).toBeCloseTo((3000 - crop.width) / 2);
  });
});
