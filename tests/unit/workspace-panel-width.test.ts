/**
 * The clamping and storage rules behind the resizable Nexus workspace split
 * (#1793). These decide whether a dashboard renders at desktop width or back at
 * the phone width the issue was filed about, and they run against values a
 * pointer drag and `localStorage` both supply — neither of which is trustworthy.
 */

import {
  DEFAULT_WORKSPACE_PANEL_WIDTH_PCT,
  MIN_CHAT_COLUMN_PX,
  MIN_WORKSPACE_PANEL_PX,
  WORKSPACE_PANEL_WIDTH_KEY,
  clampWorkspacePanelWidthPct,
  readStoredWorkspacePanelWidthPct,
  storeWorkspacePanelWidthPct,
} from "@/lib/atrium/workspace-panel-width";

describe("clampWorkspacePanelWidthPct", () => {
  const CONTAINER = 1000;

  it("leaves a fraction that satisfies both minimums alone", () => {
    expect(clampWorkspacePanelWidthPct(0.5, CONTAINER)).toBeCloseTo(0.5, 5);
  });

  it("never lets the panel fall below its own minimum", () => {
    const clamped = clampWorkspacePanelWidthPct(0.05, CONTAINER);
    expect(clamped * CONTAINER).toBeCloseTo(MIN_WORKSPACE_PANEL_PX, 5);
  });

  it("never lets the chat column fall below its minimum", () => {
    const clamped = clampWorkspacePanelWidthPct(0.95, CONTAINER);
    expect(CONTAINER - clamped * CONTAINER).toBeCloseTo(MIN_CHAT_COLUMN_PX, 5);
  });

  it("gives the panel minimum priority when the split cannot satisfy both", () => {
    // 600px cannot hold 380 + 320. The panel minimum wins: the chat still
    // scrolls, whereas a sub-380px panel is the bug being fixed.
    const narrow = 600;
    const clamped = clampWorkspacePanelWidthPct(0.2, narrow);
    expect(clamped * narrow).toBeCloseTo(MIN_WORKSPACE_PANEL_PX, 5);
  });

  it("falls back to the default for a non-finite fraction", () => {
    expect(clampWorkspacePanelWidthPct(Number.NaN, CONTAINER)).toBe(
      DEFAULT_WORKSPACE_PANEL_WIDTH_PCT
    );
  });

  it("clamps to 0–1 when the container cannot be measured", () => {
    // Before the first layout there is nothing to measure; a fraction outside
    // 0–1 would otherwise become a negative or >100% inline width.
    expect(clampWorkspacePanelWidthPct(1.4, 0)).toBe(1);
    expect(clampWorkspacePanelWidthPct(-0.3, 0)).toBe(0);
  });
});

describe("readStoredWorkspacePanelWidthPct", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to half the split when nothing is stored", () => {
    expect(readStoredWorkspacePanelWidthPct()).toBe(
      DEFAULT_WORKSPACE_PANEL_WIDTH_PCT
    );
  });

  it("round-trips a stored fraction", () => {
    storeWorkspacePanelWidthPct(0.62);
    expect(readStoredWorkspacePanelWidthPct()).toBeCloseTo(0.62, 4);
  });

  it.each(["not-a-number", "0", "1", "-0.5", "12"])(
    "ignores the out-of-range stored value %p",
    (value) => {
      window.localStorage.setItem(WORKSPACE_PANEL_WIDTH_KEY, value);
      expect(readStoredWorkspacePanelWidthPct()).toBe(
        DEFAULT_WORKSPACE_PANEL_WIDTH_PCT
      );
    }
  );

  it("survives a localStorage that throws", () => {
    const getItem = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    try {
      expect(readStoredWorkspacePanelWidthPct()).toBe(
        DEFAULT_WORKSPACE_PANEL_WIDTH_PCT
      );
    } finally {
      getItem.mockRestore();
    }
  });
});

describe("storeWorkspacePanelWidthPct", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("refuses to persist a value outside the open interval (0, 1)", () => {
    storeWorkspacePanelWidthPct(0);
    storeWorkspacePanelWidthPct(1);
    storeWorkspacePanelWidthPct(Number.NaN);
    expect(window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY)).toBeNull();
  });

  it("swallows a storage failure rather than breaking the drag", () => {
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      expect(() => storeWorkspacePanelWidthPct(0.5)).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });
});
