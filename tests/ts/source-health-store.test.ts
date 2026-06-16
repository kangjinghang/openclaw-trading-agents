// tests/ts/source-health-store.test.ts
// Tests for SourceHealthStore + computeStats (data source health tracker).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  SourceHealthStore,
  computeStats,
  parsePeriod,
  filterHistorySince,
  BUFFER_SIZE,
  type SourceCallRecord,
} from "../../src/source-health-store";

describe("computeStats (pure function)", () => {
  it("returns zero-stats for empty history", () => {
    const s = computeStats([]);
    expect(s.total_calls).toBe(0);
    expect(s.total_success).toBe(0);
    expect(s.success_rate).toBe(0);
    expect(s.last_success_ts).toBeNull();
    expect(s.last_error_ts).toBeNull();
    expect(s.last_error).toBeNull();
    expect(s.avg_duration_ms).toBeNull();
  });

  it("computes success_rate, last_success_ts, last_error, avg_duration from history", () => {
    const history: SourceCallRecord[] = [
      { ts: "2026-06-15T10:00:00Z", ticker: "t1", run_id: "r1", success: true, duration_ms: 100, error: null },
      { ts: "2026-06-15T11:00:00Z", ticker: "t2", run_id: "r2", success: false, duration_ms: 200, error: "boom" },
      { ts: "2026-06-15T12:00:00Z", ticker: "t3", run_id: "r3", success: true, duration_ms: 300, error: null },
    ];
    const s = computeStats(history);
    expect(s.total_calls).toBe(3);
    expect(s.total_success).toBe(2);
    expect(s.success_rate).toBeCloseTo(0.667, 3);
    expect(s.last_success_ts).toBe("2026-06-15T12:00:00Z");
    expect(s.last_error_ts).toBe("2026-06-15T11:00:00Z");
    expect(s.last_error).toBe("boom");
    expect(s.avg_duration_ms).toBe(200); // (100+200+300)/3
  });

  it("handles missing duration_ms (excluded from avg)", () => {
    const history: SourceCallRecord[] = [
      { ts: "t1", ticker: "x", run_id: "r", success: true, duration_ms: undefined, error: null },
      { ts: "t2", ticker: "x", run_id: "r", success: true, duration_ms: 200, error: null },
    ];
    const s = computeStats(history);
    expect(s.avg_duration_ms).toBe(200);
  });

  it("handles all-failure history (last_success_ts null)", () => {
    const history: SourceCallRecord[] = [
      { ts: "t1", ticker: "x", run_id: "r", success: false, duration_ms: 100, error: "e1" },
      { ts: "t2", ticker: "x", run_id: "r", success: false, duration_ms: 200, error: "e2" },
    ];
    const s = computeStats(history);
    expect(s.success_rate).toBe(0);
    expect(s.last_success_ts).toBeNull();
    expect(s.last_error).toBe("e2");
  });

  it("handles all-success history (last_error null)", () => {
    const history: SourceCallRecord[] = [
      { ts: "t1", ticker: "x", run_id: "r", success: true, duration_ms: 100, error: null },
    ];
    const s = computeStats(history);
    expect(s.success_rate).toBe(1);
    expect(s.last_error_ts).toBeNull();
    expect(s.last_error).toBeNull();
  });
});

describe("SourceHealthStore", () => {
  let tmpDir: string;
  let store: SourceHealthStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-health-"));
    store = new SourceHealthStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("read() returns empty state when file missing", () => {
    const state = store.read();
    expect(state.sources).toEqual({});
    expect(state.updated_at).toBe("");
    expect(state.version).toBe(1);
  });

  it("read() returns empty state when file corrupt", () => {
    fs.writeFileSync(path.join(tmpDir, "_source-health.json"), "{ not valid json", "utf-8");
    const state = store.read();
    expect(state.sources).toEqual({});
  });

  it("read() returns empty state when version mismatch", () => {
    const bad = { version: 99, updated_at: "x", sources: {} };
    fs.writeFileSync(path.join(tmpDir, "_source-health.json"), JSON.stringify(bad), "utf-8");
    const state = store.read();
    expect(state.sources).toEqual({});
    expect(state.version).toBe(1); // falls back to SCHEMA_VERSION
  });

  it("appendCalls() creates file and writes single source", () => {
    store.appendCalls(
      [{ stage: "test/x", success: true, duration_ms: 100 }],
      "688163",
      "run-1",
      "2026-06-15T10:00:00Z",
    );
    const state = store.read();
    expect(state.sources["test/x"].history).toHaveLength(1);
    expect(state.sources["test/x"].history[0].ticker).toBe("688163");
    expect(state.sources["test/x"].history[0].run_id).toBe("run-1");
    expect(state.sources["test/x"].stats.success_rate).toBe(1);
    expect(state.sources["test/x"].stats.total_calls).toBe(1);
    expect(state.updated_at).toBe("2026-06-15T10:00:00Z");
  });

  it("appendCalls() accumulates across multiple invocations", () => {
    store.appendCalls([{ stage: "test/x", success: true }], "t1", "r1", "ts1");
    store.appendCalls([{ stage: "test/x", success: false, error: "e" }], "t2", "r2", "ts2");
    const state = store.read();
    expect(state.sources["test/x"].history).toHaveLength(2);
    expect(state.sources["test/x"].stats.success_rate).toBe(0.5);
    expect(state.sources["test/x"].stats.last_error).toBe("e");
  });

  it("ring buffer caps at BUFFER_SIZE entries (FIFO eviction)", () => {
    // Batch all records into a single appendCalls call: one atomic write
    // (matches how orchestrator uses it — one run → one appendCalls with all
    // source calls). 2005 individual appendCalls would work but exceeds the
    // default 5s test timeout because each call fsyncs independently.
    const calls = [];
    for (let i = 0; i < BUFFER_SIZE + 5; i++) {
      calls.push({
        stage: "test/x",
        success: i % 2 === 0,
        duration_ms: i,
      });
    }
    store.appendCalls(calls, "t-shared", "r-batch");

    const state = store.read();
    expect(state.sources["test/x"].history).toHaveLength(BUFFER_SIZE);
    // appendCalls pushes one-at-a-time then applies slice(-BUFFER_SIZE) after
    // each push, so the first 5 records (i=0..4) are evicted; verify via
    // duration_ms since all records share the same ticker/run_id in batched form.
    const durations = state.sources["test/x"].history.map((h) => h.duration_ms);
    expect(durations[0]).toBe(5);
    expect(durations[BUFFER_SIZE - 1]).toBe(BUFFER_SIZE + 4);
  });

  it("appendCalls() with empty array does not write file", () => {
    store.appendCalls([], "t1", "r1");
    expect(fs.existsSync(path.join(tmpDir, "_source-health.json"))).toBe(false);
  });

  it("appendCalls() groups calls by stage in one invocation", () => {
    store.appendCalls(
      [
        { stage: "test/a", success: true },
        { stage: "test/b", success: false, error: "x" },
        { stage: "test/a", success: false, error: "y" },
      ],
      "t1",
      "r1",
      "ts1",
    );
    const state = store.read();
    expect(Object.keys(state.sources).sort()).toEqual(["test/a", "test/b"]);
    expect(state.sources["test/a"].history).toHaveLength(2);
    expect(state.sources["test/b"].history).toHaveLength(1);
  });

  it("appendCalls() handles null error and null duration_ms", () => {
    store.appendCalls(
      [{ stage: "test/x", success: true, error: null, duration_ms: null }],
      "t1",
      "r1",
    );
    const state = store.read();
    expect(state.sources["test/x"].history[0].error).toBeNull();
    expect(state.sources["test/x"].history[0].duration_ms).toBeNull();
  });

  it("appendCalls() persists to disk (read after write returns same data)", () => {
    store.appendCalls(
      [{ stage: "kline/mootdx", success: true, duration_ms: 1234 }],
      "688662",
      "run-xyz",
    );
    // New store instance, same path
    const store2 = new SourceHealthStore(tmpDir);
    const state = store2.read();
    expect(state.sources["kline/mootdx"].history[0].ticker).toBe("688662");
    expect(state.sources["kline/mootdx"].history[0].duration_ms).toBe(1234);
  });
});

describe("parsePeriod", () => {
  // null = no filter (all / undefined / empty)
  it("returns null for 'all'", () => {
    expect(parsePeriod("all")).toBeNull();
  });
  it("returns null for undefined", () => {
    expect(parsePeriod(undefined)).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(parsePeriod("")).toBeNull();
  });

  // string = ISO since timestamp
  it("parses '7d' as 7-day window ending at now", () => {
    const before = Date.now();
    const since = parsePeriod("7d");
    const after = Date.now();
    expect(typeof since).toBe("string");
    // since should be ~7 days before now (allow clock skew across the call)
    const sinceMs = new Date(since as string).getTime();
    const expectedLo = before - 7 * 24 * 60 * 60 * 1000 - 5000;
    const expectedHi = after - 7 * 24 * 60 * 60 * 1000 + 5000;
    expect(sinceMs).toBeGreaterThanOrEqual(expectedLo);
    expect(sinceMs).toBeLessThanOrEqual(expectedHi);
  });
  it("parses '3d', '30d', '90d'", () => {
    for (const p of ["3d", "30d", "90d"]) {
      const since = parsePeriod(p);
      expect(typeof since).toBe("string");
      // sanity: the day count is encoded in the delta
      const days = Number(p.replace("d", ""));
      const deltaMs = Date.now() - new Date(since as string).getTime();
      const deltaDays = deltaMs / (24 * 60 * 60 * 1000);
      expect(deltaDays).toBeGreaterThan(days - 0.5);
      expect(deltaDays).toBeLessThan(days + 0.5);
    }
  });
  it("parses '1y' as ~365 days", () => {
    const since = parsePeriod("1y");
    expect(typeof since).toBe("string");
    const deltaDays =
      (Date.now() - new Date(since as string).getTime()) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThan(364);
    expect(deltaDays).toBeLessThan(366);
  });
  it("parses '1w' as 7 days (alias)", () => {
    const since = parsePeriod("1w");
    expect(typeof since).toBe("string");
    const deltaDays =
      (Date.now() - new Date(since as string).getTime()) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThan(6.5);
    expect(deltaDays).toBeLessThan(7.5);
  });
  it("parses '6m' as 30*6 = 180 days (alias)", () => {
    const since = parsePeriod("6m");
    expect(typeof since).toBe("string");
    const deltaDays =
      (Date.now() - new Date(since as string).getTime()) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThan(179);
    expect(deltaDays).toBeLessThan(181);
  });

  // undefined = parse failure (invalid input)
  it("returns undefined for unknown literal 'invalid'", () => {
    expect(parsePeriod("invalid")).toBeUndefined();
  });
  it("returns undefined for unknown unit '5x'", () => {
    expect(parsePeriod("5x")).toBeUndefined();
  });
  it("returns undefined for zero '0d'", () => {
    expect(parsePeriod("0d")).toBeUndefined();
  });
  it("returns undefined for negative '-3d'", () => {
    expect(parsePeriod("-3d")).toBeUndefined();
  });
  it("returns undefined for value exceeding sanity clamp '40000d'", () => {
    expect(parsePeriod("40000d")).toBeUndefined();
  });
});

describe("filterHistorySince", () => {
  it("returns full history when all ts >= since", () => {
    const history: SourceCallRecord[] = [
      { ts: "2026-06-15T10:00:00Z", ticker: "t", run_id: "r", success: true },
      { ts: "2026-06-16T10:00:00Z", ticker: "t", run_id: "r", success: true },
    ];
    const out = filterHistorySince(history, "2026-06-01");
    expect(out).toHaveLength(2);
  });
  it("returns empty when all ts < since", () => {
    const history: SourceCallRecord[] = [
      { ts: "2026-05-01T10:00:00Z", ticker: "t", run_id: "r", success: true },
      { ts: "2026-05-02T10:00:00Z", ticker: "t", run_id: "r", success: true },
    ];
    const out = filterHistorySince(history, "2026-06-01");
    expect(out).toHaveLength(0);
  });
  it("returns subset for mixed ts", () => {
    const history: SourceCallRecord[] = [
      { ts: "2026-05-01T10:00:00Z", ticker: "t", run_id: "r", success: true },
      { ts: "2026-06-15T10:00:00Z", ticker: "t", run_id: "r", success: true },
      { ts: "2026-06-20T10:00:00Z", ticker: "t", run_id: "r", success: true },
    ];
    const out = filterHistorySince(history, "2026-06-01");
    expect(out).toHaveLength(2);
    expect(out[0].ts).toBe("2026-06-15T10:00:00Z");
    expect(out[1].ts).toBe("2026-06-20T10:00:00Z");
  });
  it("includes record whose ts exactly equals since (>= boundary)", () => {
    const history: SourceCallRecord[] = [
      { ts: "2026-06-01", ticker: "t", run_id: "r", success: true },
      { ts: "2026-06-02", ticker: "t", run_id: "r", success: true },
    ];
    const out = filterHistorySince(history, "2026-06-01");
    expect(out).toHaveLength(2);
  });
  it("returns empty for empty history", () => {
    const out = filterHistorySince([], "2026-06-01");
    expect(out).toHaveLength(0);
  });
  it("ISO lexicographic compare works as expected (Z-suffix after date-only since)", () => {
    // Demonstrates the "ISO string dictionary order == time order" property the
    // filter relies on (no Date.parse needed): '2026-06-15T10:00:00Z' >= '2026-06-01'
    expect("2026-06-15T10:00:00Z" >= "2026-06-01").toBe(true);
    expect("2026-05-31T23:59:59Z" >= "2026-06-01").toBe(false);

    const history: SourceCallRecord[] = [
      { ts: "2026-06-15T10:00:00Z", ticker: "t", run_id: "r", success: true },
    ];
    const out = filterHistorySince(history, "2026-06-01");
    expect(out).toHaveLength(1);
  });
});
