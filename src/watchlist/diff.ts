import type { RawSnapshotFile, DiffFile, DiffChange, RawReason, RawRange } from "./types";

function rangeKey(r: RawRange): string {
  return `${r.begin}-${r.end}`;
}

/**
 * Compute diff between today's snapshot and a baseline snapshot.
 * reason_list: 集合求差，以 timestamp 为主键
 * range_reason_list: 集合求差，以 begin+end 组合为主键
 */
export function computeDiff(today: RawSnapshotFile, baseline: RawSnapshotFile | null): DiffFile {
  const changes: DiffChange[] = [];

  for (const [ticker, todayEntry] of Object.entries(today.stocks)) {
    if (todayEntry.scan_error) continue;

    const baselineEntry = baseline?.stocks?.[ticker];

    const baselineTs = new Set<number>();
    if (baselineEntry?.reason_list) {
      for (const r of baselineEntry.reason_list) baselineTs.add(r.timestamp);
    }
    const newReasons: RawReason[] = (todayEntry.reason_list ?? []).filter(
      (r) => !baselineTs.has(r.timestamp),
    );

    const baselineRangeKeys = new Set<string>();
    if (baselineEntry?.range_reason_list) {
      for (const r of baselineEntry.range_reason_list) baselineRangeKeys.add(rangeKey(r));
    }
    const newRanges: RawRange[] = (todayEntry.range_reason_list ?? []).filter(
      (r) => !baselineRangeKeys.has(rangeKey(r)),
    );

    if (newReasons.length > 0 || newRanges.length > 0) {
      changes.push({
        ticker,
        name: todayEntry.name,
        new_reason_points: newReasons,
        new_range_trends: newRanges,
      });
    }
  }

  return {
    scan_date: today.scan_date,
    baseline: baseline?.scan_date ?? "",
    changes,
  };
}
