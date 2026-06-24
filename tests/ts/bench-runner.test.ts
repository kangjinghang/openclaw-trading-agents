// tests/ts/bench-runner.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expandApiKey, validateConfig, parseOutput, extractTicker, selectTraces } from "../../src/watchlist/bench-runner";
import type { BenchConfig, BenchCallResult } from "../../src/watchlist/bench-types";

describe("expandApiKey", () => {
  it("expands $ENV-prefixed key from env", () => {
    process.env.BENCH_TEST_KEY = "secret123";
    expect(expandApiKey("$BENCH_TEST_KEY")).toBe("secret123");
    delete process.env.BENCH_TEST_KEY;
  });

  it("returns literal when no $ prefix", () => {
    expect(expandApiKey("sk-literal")).toBe("sk-literal");
  });

  it("throws when $ENV var is unset", () => {
    expect(() => expandApiKey("$BENCH_DEFINITELY_UNSET_XYZ")).toThrow(/BENCH_DEFINITELY_UNSET_XYZ/);
  });
});

describe("validateConfig", () => {
  const valid: BenchConfig = {
    name: "t",
    traces: { phase: "rank", date: "2026-06-23" },
    repeats: 3,
    providers: { zhipu: { base_url: "https://x", api_key: "$ZHIPU_API_KEY" } },
    configs: [{ id: "c1", provider: "zhipu", model: "glm-5.2" }],
  };

  it("passes a valid config", () => {
    process.env.ZHIPU_API_KEY = "k";
    expect(() => validateConfig(valid)).not.toThrow();
    delete process.env.ZHIPU_API_KEY;
  });

  it("throws when provider reference missing", () => {
    // 用字面量 key 避免 $ENV 展开抢先抛错（展开在校验前）
    const bad: BenchConfig = {
      ...valid,
      providers: { zhipu: { base_url: "https://x", api_key: "literal-key" } },
      configs: [{ id: "c1", provider: "nope", model: "glm-5.2" }],
    };
    expect(() => validateConfig(bad)).toThrow(/provider.*nope/i);
  });

  it("throws when phase invalid", () => {
    const bad = { ...valid, traces: { phase: "trading" } } as any;
    expect(() => validateConfig(bad)).toThrow(/phase/);
  });

  it("throws when repeats <= 0", () => {
    const bad = { ...valid, repeats: 0 };
    expect(() => validateConfig(bad)).toThrow(/repeats/);
  });
});

describe("parseOutput", () => {
  it("parses shallow analyst JSON", () => {
    const raw = JSON.stringify({
      thesis: "test", fitness_score: 7, key_signals: ["s1"],
    });
    const p = parseOutput(raw);
    expect(p._parse_ok).toBe(true);
    expect(p.fitness_score).toBe(7);
    expect(p.thesis).toBe("test");
  });

  it("parses shallow risk JSON", () => {
    const raw = JSON.stringify({
      risk_flags: [{ flag: "x", severity: "高" }],
      overall_risk: "high", deal_breaker: false,
    });
    const p = parseOutput(raw);
    expect(p._parse_ok).toBe(true);
    expect(p.overall_risk).toBe("high");
    expect(p.risk_flags).toHaveLength(1);
    expect(p.deal_breaker).toBe(false);
  });

  it("parses rank ranked array", () => {
    const raw = JSON.stringify({ ranked: [{ ticker: "002167", score: 9.5 }, { ticker: "600519", score: 8 }] });
    const p = parseOutput(raw);
    expect(p._parse_ok).toBe(true);
    expect(p.ranked).toHaveLength(2);
    expect(p.ranked![0].ticker).toBe("002167");
  });

  it("handles leading/trailing non-JSON text", () => {
    const raw = "```json\n{\"fitness_score\":6}\n```";
    const p = parseOutput(raw);
    expect(p._parse_ok).toBe(true);
    expect(p.fitness_score).toBe(6);
  });

  it("returns _parse_ok=false on garbage", () => {
    expect(parseOutput("not json at all")._parse_ok).toBe(false);
  });
});

describe("extractTicker", () => {
  it("extracts 6-digit A-share code after 股票", () => {
    expect(extractTicker("分析股票 002167 东方锆业的数据")).toBe("002167");
  });

  it("extracts code after ticker label", () => {
    expect(extractTicker("ticker: 600519")).toBe("600519");
  });

  it("returns unknown when no code found", () => {
    expect(extractTicker("no codes here")).toBe("unknown");
  });
});

function writeTrace(dir: string, filename: string, role: string, phase: string, userMsg: string, raw: string) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify({
    trace_id: "x", role, phase,
    request: { model: "m", system_prompt: "s", user_message: userMsg, temperature: 0, max_tokens: 100 },
    response: { raw_content: raw },
    meta: { timestamp: "t", duration_ms: 1000, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, cost_usd: 0 },
  }));
}

describe("selectTraces", () => {
  let tmpRoot: string;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bench-")); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it("selects rebalance shallow traces by date+roles", () => {
    const traceDir = path.join(tmpRoot, "rebalance", "2026-06-23", "traces");
    fs.mkdirSync(traceDir, { recursive: true });
    writeTrace(traceDir, "analyst-shallow-trace-1.json", "analyst-shallow", "rebalance", "股票 002167", JSON.stringify({ fitness_score: 4 }));
    writeTrace(traceDir, "risk-shallow-trace-1.json", "risk-shallow", "rebalance", "股票 002167", JSON.stringify({ overall_risk: "high" }));
    writeTrace(traceDir, "portfolio-rebalancer-trace-1.json", "portfolio-rebalancer", "rebalance", "组合", "{}");

    const selected = selectTraces(tmpRoot, { phase: "rebalance", date: "2026-06-23", roles: ["analyst-shallow"] });
    expect(selected).toHaveLength(1);
    expect(selected[0].role).toBe("analyst-shallow");
    expect(selected[0].ticker).toBe("002167");
    expect(selected[0].baseline_parsed.fitness_score).toBe(4);
  });

  it("selects rank traces (no roles filter = all)", () => {
    const traceDir = path.join(tmpRoot, "scan", "2026-06-23", "traces");
    fs.mkdirSync(traceDir, { recursive: true });
    writeTrace(traceDir, "long-ranker-trace-1.json", "long-ranker", "rank", "多股", JSON.stringify({ ranked: [{ ticker: "a", score: 9 }] }));
    writeTrace(traceDir, "short-ranker-trace-1.json", "short-ranker", "rank", "多股", "{}");

    const selected = selectTraces(tmpRoot, { phase: "rank", date: "2026-06-23" });
    expect(selected).toHaveLength(2);
    expect(selected[0].role).toBe("long-ranker");
  });

  it("respects limit", () => {
    const traceDir = path.join(tmpRoot, "scan", "2026-06-23", "traces");
    fs.mkdirSync(traceDir, { recursive: true });
    writeTrace(traceDir, "long-ranker-trace-1.json", "long-ranker", "rank", "x", "{}");
    writeTrace(traceDir, "short-ranker-trace-1.json", "short-ranker", "rank", "x", "{}");
    const selected = selectTraces(tmpRoot, { phase: "rank", date: "2026-06-23", limit: 1 });
    expect(selected).toHaveLength(1);
  });

  it("picks latest date when date omitted", () => {
    for (const d of ["2026-06-22", "2026-06-23"]) {
      const td = path.join(tmpRoot, "scan", d, "traces");
      fs.mkdirSync(td, { recursive: true });
      writeTrace(td, "long-ranker-trace-1.json", "long-ranker", "rank", "x", "{}");
    }
    const selected = selectTraces(tmpRoot, { phase: "rank" });
    // file 只是文件名（不含日期）；日期在 path 里
    expect(selected[0].path).toContain("2026-06-23");
  });
});
