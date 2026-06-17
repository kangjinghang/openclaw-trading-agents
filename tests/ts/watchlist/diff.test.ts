import { describe, it, expect } from "vitest";
import { computeDiff } from "../../../src/watchlist/diff";
import type { RawSnapshotFile, DiffFile } from "../../../src/watchlist/types";

function makeSnapshot(date: string, stocks: Record<string, any>): RawSnapshotFile {
  return {
    scan_date: date, begin_ms: 0, end_ms: 0, begin_date: date, end_date: date,
    window_months: 14, scanned: 0, succeeded: 0, failed: 0, stocks,
  };
}

describe("computeDiff", () => {
  it("finds newly added reason points by timestamp", () => {
    const baseline = makeSnapshot("2026-06-16", {
      "SH688146": { name: "中船特气", reason_list: [{ timestamp: 1000, reason: "old" }] },
    });
    const today = makeSnapshot("2026-06-17", {
      "SH688146": {
        name: "中船特气",
        reason_list: [
          { timestamp: 1000, reason: "old" },
          { timestamp: 2000, reason: "new today" },
        ],
      },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].new_reason_points).toEqual([{ timestamp: 2000, reason: "new today" }]);
  });

  it("finds newly added range trends by begin+end key", () => {
    const baseline = makeSnapshot("2026-06-16", {
      "SH688146": { name: "中船特气", range_reason_list: [{ begin: 100, end: 200, type: "SHORT", percent: 10, summary: "old", points: "" }] },
    });
    const today = makeSnapshot("2026-06-17", {
      "SH688146": {
        name: "中船特气",
        range_reason_list: [
          { begin: 100, end: 200, type: "SHORT", percent: 12, summary: "old-updated", points: "" },
          { begin: 300, end: 400, type: "LONG", percent: 50, summary: "new", points: "" },
        ],
      },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes[0].new_range_trends).toEqual([
      { begin: 300, end: 400, type: "LONG", percent: 50, summary: "new", points: "" },
    ]);
  });

  it("does not flag a stock with no changes", () => {
    const baseline = makeSnapshot("2026-06-16", { "SH688146": { name: "x", reason_list: [{ timestamp: 1, reason: "a" }] } });
    const today = makeSnapshot("2026-06-17", { "SH688146": { name: "x", reason_list: [{ timestamp: 1, reason: "a" }] } });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });

  it("treats all elements as new when baseline is null (first scan)", () => {
    const today = makeSnapshot("2026-06-17", {
      "SH688146": { name: "中船特气", reason_list: [{ timestamp: 1, reason: "first" }] },
    });
    const diff = computeDiff(today, null);
    expect(diff.changes[0].new_reason_points).toHaveLength(1);
    expect(diff.baseline).toBe("");
  });

  it("skips stocks with scan_error", () => {
    const baseline = makeSnapshot("2026-06-16", {});
    const today = makeSnapshot("2026-06-17", { "SH000001": { name: "x", scan_error: "timeout" } });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });

  it("captures stocks present in baseline but missing today as no-change", () => {
    const baseline = makeSnapshot("2026-06-16", { "SH688146": { name: "x", reason_list: [{ timestamp: 1, reason: "a" }] } });
    const today = makeSnapshot("2026-06-17", {});
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });
});
