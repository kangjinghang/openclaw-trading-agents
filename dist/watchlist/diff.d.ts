import type { RawSnapshotFile, DiffFile } from "./types";
/**
 * Compute diff between today's snapshot and a baseline snapshot.
 * reason_list: 集合求差，以 timestamp 为主键
 * range_reason_list: 集合求差，以 begin+end 组合为主键
 */
export declare function computeDiff(today: RawSnapshotFile, baseline: RawSnapshotFile | null): DiffFile;
//# sourceMappingURL=diff.d.ts.map