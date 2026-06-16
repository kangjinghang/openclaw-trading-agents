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
 * Pure function: derive stats from a history array. Exported for unit testing.
 * Handles empty history, missing duration_ms, and ordering (last_success_ts /
 * last_error_ts are derived from array order, not recomputed max — assumes the
 * caller appends in chronological order).
 */
export declare function computeStats(history: SourceCallRecord[]): SourceStats;
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