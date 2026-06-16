// tests/ts/source-health-store.test.ts
// Tests for SourceHealthStore + computeStats (data source health tracker).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  SourceHealthStore,
  computeStats,
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

  it("ring buffer caps at 20 entries (FIFO eviction)", () => {
    for (let i = 0; i < 25; i++) {
      store.appendCalls(
        [{ stage: "test/x", success: i % 2 === 0, duration_ms: i }],
        `t${i}`,
        `r${i}`,
        `ts${i}`,
      );
    }
    const state = store.read();
    expect(state.sources["test/x"].history).toHaveLength(20);
    // Oldest 5 dropped; first remaining should be i=5
    expect(state.sources["test/x"].history[0].ticker).toBe("t5");
    expect(state.sources["test/x"].history[19].ticker).toBe("t24");
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
