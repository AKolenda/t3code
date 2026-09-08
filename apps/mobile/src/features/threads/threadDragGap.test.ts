import { describe, expect, it } from "vite-plus/test";
import { threadDragGapOffset } from "./threadDragGap";

describe("live thread insertion gap", () => {
  // Header, pinned row, Active header, two active rows. Geometry stays fixed for hit testing.
  const offsets = [0, 48, 120, 168, 240];
  const shifts = (source: number, insertion: number) =>
    offsets.map((offset) => threadDragGapOffset(offset, source, 72, insertion));

  it("moves the Active header and intervening rows up when unpinning", () => {
    expect(shifts(48, 312)).toEqual([0, 0, -72, -72, -72]);
  });
  it("opens a full gap below the Pinned header when pinning", () => {
    expect(shifts(240, 48)).toEqual([0, 72, 72, 72, 0]);
  });
  it("leaves the source gap in place for cancellation or its current destination", () => {
    expect(shifts(168, 168)).toEqual([0, 0, 0, 0, 0]);
    expect(shifts(168, 240)).toEqual([0, 0, 0, 0, 0]);
  });
  it("moves only crossed rows for an adjacent reorder", () => {
    expect(shifts(168, 312)).toEqual([0, 0, 0, 0, -72]);
    expect(shifts(240, 168)).toEqual([0, 0, 0, 72, 0]);
  });
});
