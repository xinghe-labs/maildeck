import { describe, expect, it } from "vitest";
import { resolveFixedVirtualWindow } from "../src/fixed-virtual-window";

describe("resolveFixedVirtualWindow", () => {
  it("returns an overscanned slice around the visible rows", () => {
    expect(
      resolveFixedVirtualWindow({
        itemCount: 5_000,
        itemHeight: 74,
        scrollTop: 7_400,
        viewportHeight: 660,
        overscan: 4
      })
    ).toEqual({
      startIndex: 96,
      endIndex: 113,
      offsetTop: 7_104,
      totalHeight: 370_000,
      scrollTop: 7_400
    });
  });

  it("clamps stale scroll positions after the list shrinks", () => {
    expect(
      resolveFixedVirtualWindow({
        itemCount: 10,
        itemHeight: 74,
        scrollTop: 20_000,
        viewportHeight: 300,
        overscan: 2
      })
    ).toEqual({
      startIndex: 3,
      endIndex: 10,
      offsetTop: 222,
      totalHeight: 740,
      scrollTop: 440
    });
  });

  it("returns an empty window for an empty list", () => {
    expect(
      resolveFixedVirtualWindow({
        itemCount: 0,
        itemHeight: 74,
        scrollTop: 10,
        viewportHeight: 300
      })
    ).toEqual({
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight: 0,
      scrollTop: 0
    });
  });
});
