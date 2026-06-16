/** Per-source call record accumulated in the ring buffer. */
export interface SourceCallRecord {
    /** ISO timestamp of the run that produced this call. */
    ts: string;
    /** Ticker analyzed in the run. */
    ticker: string;
    /** Run ID (matches report.json.run_id). */
    run_id: string;
    /** True if the call yielded usable data. */
    success: boolean;
    /** Call duration in ms (for slow-source detection); null if unknown. */
    duration_ms?: number | null;
    /** Short error message if failed; null if succeeded. */
    error?: string | null;
}
/** Derived per-source stats computed from the ring buffer. */
export interface SourceStats {
    /** Total calls in the ring buffer (max = BUFFER_SIZE). */
    total_calls: number;
    /** Successful calls. */
    total_success: number;
    /** success / total (0-1). */
    success_rate: number;
    /** ISO ts of the most recent success; null if none. */
    last_success_ts: string | null;
    /** ISO ts of the most recent failure; null if none. */
    last_error_ts: string | null;
    /** Short error message of the most recent failure; null if none. */
    last_error: string | null;
    /** Average duration_ms across records that have it; null if none. */
    avg_duration_ms: number | null;
}
export interface SourceHealthEntry {
    history: SourceCallRecord[];
    stats: SourceStats;
}
export interface SourceHealthFile {
    version: number;
    updated_at: string;
    sources: Record<string, SourceHealthEntry>;
}
/**
 * Ring buffer size per source. Sized to cover 1+ year of history so that
 * multi-period stats (3d / 7d / 30d / 1y / all) can be computed read-time via
 * `filterHistorySince` without per-day aggregation.
 *
 * Coverage at this cap:
 *   - 1 run/day  → ~5.5 years
 *   - 5 runs/day → ~13 months
 *   - 20 runs/day → ~100 days
 *
 * Worst-case file size at 22 sources × 2000 records × ~150 bytes ≈ 6.3 MB raw
 * (8 MB pretty JSON); atomic write (tmp + rename) keeps partial writes from
 * surfacing. orchestrator only calls `appendCalls` once per ~5-10 min, so I/O
 * is not a bottleneck.
 */
export declare const BUFFER_SIZE = 2000;
/**
 * Pure function: derive stats from a history array. Exported for unit testing.
 * Handles empty history, missing duration_ms, and ordering (last_success_ts /
 * last_error_ts are derived from array order, not recomputed max — assumes the
 * caller appends in chronological order).
 */
export declare function computeStats(history: SourceCallRecord[]): SourceStats;
/**
 * Parse a period token (e.g. `"7d"`, `"1y"`, `"all"`) into either:
 *   - `null`    → no filter (the entire ring buffer; `"all"` / undefined / empty)
 *   - `string`  → ISO timestamp of the inclusive lower bound (`since`)
 *   - `undefined` → parse failure (CLI should reject and exit)
 *
 * ISO since is derived from `Date.now() - days*86400_000`, NOT from a calendar
 * reference, so 1m = 30d (not "same day last month") for consistency with the
 * downstream ISO string compare in `filterHistorySince`.
 */
export declare function parsePeriod(period: string | undefined): string | null | undefined;
/**
 * Pure filter: keep records whose `ts` is `>= since` (inclusive lower bound).
 *
 * ISO 8601 timestamps have the desirable property that lexicographic order
 * matches chronological order **provided both operands are the same shape**
 * (both date-only, or both full RFC3339 with the same timezone suffix).
 * `parsePeriod` returns full ISO (with `Z`), which sorts correctly against
 * both date-only prefixes (`"2026-06-15..."` >= `"2026-06-01"`) and full
 * timestamps (`"2026-06-15T10:00:00Z"` >= `"2026-06-01T00:00:00.000Z"`).
 *
 * No `Date.parse` involved — stays robust to malformed inputs (returns the
 * record, never throws).
 */
export declare function filterHistorySince(history: SourceCallRecord[], since: string): SourceCallRecord[];
/**
 * Persistent cross-run store of per-source call results. One instance per
 * pipeline run; reads/writes a single JSON file at `<reportDir>/_source-health.json`.
 *
 * Design invariants:
 * 1. `read()` never throws — missing/corrupt file returns empty state. This
 *    ensures source-health tracking can never block the analysis pipeline.
 * 2. `appendCalls()` is the only writer; reads → mutates in-memory → atomic
 *    write (tmp + rename, same pattern as report-store).
 * 3. Ring buffer caps history at BUFFER_SIZE per source (FIFO eviction).
 */
export declare class SourceHealthStore {
    private readonly filePath;
    constructor(reportDir: string);
    /**
     * Read the health file. Returns empty state on missing/corrupt file.
     * Never throws — source-health tracking must not break the pipeline.
     */
    read(): SourceHealthFile;
    /**
     * Append per-source calls from one run, then write atomically.
     * Skips silently if calls is empty. Swallows write errors (logs to stderr).
     *
     * Each call is appended to its stage's ring buffer (capped at BUFFER_SIZE,
     * FIFO eviction). Stats are recomputed from the resulting history.
     */
    appendCalls(calls: Array<{
        stage: string;
        success: boolean;
        error?: string | null;
        duration_ms?: number | null;
    }>, ticker: string, runId: string, timestamp?: string): void;
    /**
     * Atomic write (tmp + rename, same pattern as report-store). Failures are
     * logged to stderr but never thrown — pipeline continues regardless.
     */
    private write;
}
//# sourceMappingURL=source-health-store.d.ts.map