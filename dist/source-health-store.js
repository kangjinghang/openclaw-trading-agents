"use strict";
// src/source-health-store.ts
// Cross-run data source health tracker.
// Spec: docs/superpowers/specs/2026-06-15-data-source-health-design.md
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SourceHealthStore = exports.BUFFER_SIZE = void 0;
exports.computeStats = computeStats;
exports.parsePeriod = parsePeriod;
exports.filterHistorySince = filterHistorySince;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
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
exports.BUFFER_SIZE = 2000;
/** File schema version (bump on breaking shape changes; add migration logic). */
const SCHEMA_VERSION = 1;
/**
 * Pure function: derive stats from a history array. Exported for unit testing.
 * Handles empty history, missing duration_ms, and ordering (last_success_ts /
 * last_error_ts are derived from array order, not recomputed max — assumes the
 * caller appends in chronological order).
 */
function computeStats(history) {
    if (history.length === 0) {
        return {
            total_calls: 0,
            total_success: 0,
            success_rate: 0,
            last_success_ts: null,
            last_error_ts: null,
            last_error: null,
            avg_duration_ms: null,
        };
    }
    const successes = history.filter((h) => h.success);
    const failures = history.filter((h) => !h.success);
    const durations = history
        .map((h) => h.duration_ms)
        .filter((d) => typeof d === "number" && !Number.isNaN(d));
    return {
        total_calls: history.length,
        total_success: successes.length,
        success_rate: successes.length / history.length,
        last_success_ts: successes.length > 0 ? successes[successes.length - 1].ts : null,
        last_error_ts: failures.length > 0 ? failures[failures.length - 1].ts : null,
        last_error: failures.length > 0 ? failures[failures.length - 1].error ?? null : null,
        avg_duration_ms: durations.length > 0
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : null,
    };
}
/**
 * Days-per-unit table for `parsePeriod`. `m` is a 30-day alias (calendar-month
 * semantics would require a reference date — overkill for health stats).
 */
const PERIOD_UNITS = {
    d: 1,
    w: 7,
    m: 30,
    y: 365,
};
/** Sanity clamp: anything over 100 years is treated as a typo. */
const PERIOD_MAX_DAYS = 36500;
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
function parsePeriod(period) {
    if (period === undefined || period === "" || period === "all") {
        return null;
    }
    const match = /^(\d+)([dwmy])$/.exec(period);
    if (!match)
        return undefined;
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value) || value <= 0)
        return undefined;
    const days = value * PERIOD_UNITS[unit];
    if (!Number.isFinite(days) || days > PERIOD_MAX_DAYS)
        return undefined;
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    return new Date(sinceMs).toISOString();
}
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
function filterHistorySince(history, since) {
    return history.filter((r) => r.ts >= since);
}
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
class SourceHealthStore {
    constructor(reportDir) {
        this.filePath = path.join(reportDir, "_source-health.json");
    }
    /**
     * Read the health file. Returns empty state on missing/corrupt file.
     * Never throws — source-health tracking must not break the pipeline.
     */
    read() {
        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed?.version === SCHEMA_VERSION && parsed.sources) {
                return parsed;
            }
        }
        catch {
            // Missing or corrupt — fall through to empty state.
        }
        return { version: SCHEMA_VERSION, updated_at: "", sources: {} };
    }
    /**
     * Append per-source calls from one run, then write atomically.
     * Skips silently if calls is empty. Swallows write errors (logs to stderr).
     *
     * Each call is appended to its stage's ring buffer (capped at BUFFER_SIZE,
     * FIFO eviction). Stats are recomputed from the resulting history.
     */
    appendCalls(calls, ticker, runId, timestamp = new Date().toISOString()) {
        if (calls.length === 0)
            return;
        const state = this.read();
        for (const call of calls) {
            const entry = state.sources[call.stage] ?? {
                history: [],
                stats: computeStats([]),
            };
            entry.history.push({
                ts: timestamp,
                ticker,
                run_id: runId,
                success: call.success,
                duration_ms: call.duration_ms ?? null,
                error: call.error ?? null,
            });
            // Ring buffer: keep most recent BUFFER_SIZE records.
            if (entry.history.length > exports.BUFFER_SIZE) {
                entry.history = entry.history.slice(-exports.BUFFER_SIZE);
            }
            entry.stats = computeStats(entry.history);
            state.sources[call.stage] = entry;
        }
        state.updated_at = timestamp;
        this.write(state);
    }
    /**
     * Atomic write (tmp + rename, same pattern as report-store). Failures are
     * logged to stderr but never thrown — pipeline continues regardless.
     */
    write(state) {
        const tmp = this.filePath + ".tmp";
        try {
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
            fs.renameSync(tmp, this.filePath);
        }
        catch (err) {
            console.error(`[source-health] write failed: ${err instanceof Error ? err.message : err}`);
        }
    }
}
exports.SourceHealthStore = SourceHealthStore;
//# sourceMappingURL=source-health-store.js.map