// tests/ts/bench-runner.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expandApiKey, validateConfig, validateConfigStructure, parseOutput, extractTicker, selectTraces } from "../../src/watchlist/bench-runner";
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

describe("validateConfigStructure", () => {
  const valid: BenchConfig = {
    name: "t",
    traces: { phase: "rank", date: "2026-06-23" },
    repeats: 3,
    providers: { zhipu: { base_url: "https://x", api_key: "$UNSET_KEY_XYZ" } },
    configs: [{ id: "c1", provider: "zhipu", model: "glm-5.2" }],
  };

  it("passes without expanding $ENV (dry-run safe, no real key needed)", () => {
    // $UNSET_KEY_XYZ 未设也能通过——结构校验不碰 key
    expect(() => validateConfigStructure(valid)).not.toThrow();
  });

  it("throws on bad provider reference", () => {
    const bad: BenchConfig = { ...valid, configs: [{ id: "c1", provider: "nope", model: "m" }] };
    expect(() => validateConfigStructure(bad)).toThrow(/provider.*nope/i);
  });

  it("throws on invalid phase", () => {
    const bad = { ...valid, traces: { phase: "trading" } } as any;
    expect(() => validateConfigStructure(bad)).toThrow(/phase/);
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

import { runReplay, type BenchCaller } from "../../src/watchlist/bench-runner";

describe("runReplay", () => {
  let tmpRoot: string;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bench-")); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it("runs traces × configs × repeats, records ok and failures without aborting", async () => {
    // 1 trace, 2 configs, 2 repeats = 4 calls
    const traceDir = path.join(tmpRoot, "scan", "2026-06-23", "traces");
    fs.mkdirSync(traceDir, { recursive: true });
    writeTrace(traceDir, "long-ranker-trace-1.json", "long-ranker", "rank", "x", "{}");

    const traces = selectTraces(tmpRoot, { phase: "rank", date: "2026-06-23" });
    const configs = [
      { id: "c1", provider: "p", model: "m1" },
      { id: "c2", provider: "p", model: "m2" },
    ];

    // mock caller: c1 总成功；c2 第 0 次 repeat 失败
    const caller: BenchCaller = async (args) => {
      if (args.configId === "c2" && args.repeat === 0) {
        return { ok: false, error: "429 exhausted", duration_ms: 100, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0, raw_content: "", parsed: { _parse_ok: false } };
      }
      return {
        ok: true, duration_ms: 500, cost_usd: 0.01,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        raw_content: JSON.stringify({ ranked: [{ ticker: "a", score: 9 }] }),
        parsed: { _parse_ok: true, ranked: [{ ticker: "a", score: 9 }] },
      };
    };

    const results = await runReplay(traces, configs, 2, caller);
    expect(results).toHaveLength(4);   // 1 trace × 2 config × 2 repeat
    const failed = results.filter(r => !r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].config_id).toBe("c2");
    expect(failed[0].repeat).toBe(0);
    expect(failed[0].error).toBe("429 exhausted");
    // 每条都有 trace_file / config_id / repeat
    expect(results[0].trace_file).toBe("long-ranker-trace-1.json");
  });

  it("survives caller throwing (records as failure, continues)", async () => {
    const traceDir = path.join(tmpRoot, "scan", "2026-06-23", "traces");
    fs.mkdirSync(traceDir, { recursive: true });
    writeTrace(traceDir, "long-ranker-trace-1.json", "long-ranker", "rank", "x", "{}");
    const traces = selectTraces(tmpRoot, { phase: "rank", date: "2026-06-23" });

    const caller: BenchCaller = async () => { throw new Error("boom"); };
    const results = await runReplay(traces, [{ id: "c1", provider: "p", model: "m" }], 1, caller);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBe("boom");
  });
});

import {
  computeStability, formatReport,
} from "../../src/watchlist/bench-runner";
import type { ParsedOutput, SelectedTrace, BenchResults, ConfigStats, StabilityStats } from "../../src/watchlist/bench-types";

// helper：构造稳定性测试用 BenchCallResult
function makeStabCall(phase: string, configId: string, traceFile: string, parsed: ParsedOutput): BenchCallResult {
  return {
    trace_file: traceFile, config_id: configId, repeat: 0, ok: true,
    duration_ms: 100, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cost_usd: 0, raw_content: "{}", parsed,
  };
}

describe("computeStability", () => {
  it("computes topK consistency + baseline score diff for rank phase", () => {
    const calls: BenchCallResult[] = [
      makeStabCall("rank", "c1", "t", { _parse_ok: true, ranked: [{ ticker: "a", score: 9 }, { ticker: "b", score: 8 }] }),
      makeStabCall("rank", "c1", "t", { _parse_ok: true, ranked: [{ ticker: "a", score: 9 }, { ticker: "c", score: 7 }] }),
    ];
    const baseline: SelectedTrace = {
      file: "t", path: "t", role: "long-ranker", phase: "rank", ticker: "long-ranker",
      baseline_duration_ms: 0, baseline_parsed: { _parse_ok: true, ranked: [{ ticker: "a", score: 10 }, { ticker: "b", score: 9 }] },
    };
    const stab = computeStability("c1", baseline, calls);
    expect(stab.numeric_cv).toBeNull();   // rank 不用 numeric CV
    expect(stab.mode_consistency).toBeNull();
    // top-K: [a,b] vs [a,c] overlap {a}=1, denom=min(3,min(2,2))=2 → 0.5
    expect(stab.topk_consistency).toBeCloseTo(0.5, 2);
    expect(stab.baseline_score_diff).not.toBeNull();
  });

  it("computes fitness CV for analyst-shallow", () => {
    const calls: BenchCallResult[] = [
      makeStabCall("rebalance", "c1", "t", { _parse_ok: true, fitness_score: 4 }),
      makeStabCall("rebalance", "c1", "t", { _parse_ok: true, fitness_score: 5 }),
      makeStabCall("rebalance", "c1", "t", { _parse_ok: true, fitness_score: 4 }),
    ];
    const baseline: SelectedTrace = {
      file: "t", path: "t", role: "analyst-shallow", phase: "rebalance", ticker: "002167",
      baseline_duration_ms: 0, baseline_parsed: { _parse_ok: true, fitness_score: 4 },
    };
    const stab = computeStability("c1", baseline, calls);
    // values [4,5,4] mean=4.33 → CV 小正数
    expect(stab.numeric_cv).not.toBeNull();
    expect(stab.numeric_cv!).toBeGreaterThan(0);
    expect(stab.topk_consistency).toBeNull();
  });

  it("computes mode consistency + flag-count CV + deal_breaker rate for risk-shallow", () => {
    const calls: BenchCallResult[] = [
      makeStabCall("rebalance", "c1", "t", { _parse_ok: true, overall_risk: "high", risk_flags: [{ flag: "x", severity: "高" }], deal_breaker: true }),
      makeStabCall("rebalance", "c1", "t", { _parse_ok: true, overall_risk: "high", risk_flags: [{ flag: "x", severity: "高" }, { flag: "y", severity: "中" }], deal_breaker: false }),
    ];
    const baseline: SelectedTrace = {
      file: "t", path: "t", role: "risk-shallow", phase: "rebalance", ticker: "002167",
      baseline_duration_ms: 0, baseline_parsed: { _parse_ok: true, overall_risk: "high" },
    };
    const stab = computeStability("c1", baseline, calls);
    // overall_risk [high,high] → mode 1.0
    expect(stab.mode_consistency).toBe(1);
    // risk_flags counts [1,2] → numeric_cv 用 flag 数量
    expect(stab.numeric_cv).not.toBeNull();
    // deal_breaker [true,false] → true 占比 0.5
    expect(stab.deal_breaker_true_rate).toBeCloseTo(0.5, 2);
  });

  it("deal_breaker_true_rate is null when no call sets it", () => {
    const calls: BenchCallResult[] = [
      makeStabCall("rebalance", "c1", "t", { _parse_ok: true, overall_risk: "high" }),
    ];
    const baseline: SelectedTrace = {
      file: "t", path: "t", role: "risk-shallow", phase: "rebalance", ticker: "002167",
      baseline_duration_ms: 0, baseline_parsed: { _parse_ok: true },
    };
    expect(computeStability("c1", baseline, calls).deal_breaker_true_rate).toBeNull();
  });
});

describe("formatReport", () => {
  it("renders overview + stability + per-sample sections", () => {
    const results: BenchResults = {
      bench_name: "test-bench",
      config_path: "bench/x.json",
      started_at: "2026-06-24T00:00:00Z",
      finished_at: "2026-06-24T00:01:00Z",
      trace_count: 1, repeats: 2, config_count: 1, total_calls: 2,
      traces: [{ file: "analyst-shallow-trace-1.json", role: "analyst-shallow", phase: "rebalance", ticker: "002167", baseline_duration_ms: 1000, baseline_parsed: { _parse_ok: true, fitness_score: 4 } }],
      results: [
        { trace_file: "analyst-shallow-trace-1.json", config_id: "c1", repeat: 0, ok: true, duration_ms: 500, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, cost_usd: 0.01, raw_content: "{}", parsed: { _parse_ok: true, fitness_score: 4 } },
        { trace_file: "analyst-shallow-trace-1.json", config_id: "c1", repeat: 1, ok: true, duration_ms: 600, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, cost_usd: 0.01, raw_content: "{}", parsed: { _parse_ok: true, fitness_score: 5 } },
      ],
    };
    const configStats: ConfigStats[] = [{
      config_id: "c1", success_rate: 1, success_count: 2, expected_calls: 2,
      duration_median_ms: 500, duration_p90_ms: 600, prompt_tokens_median: 100,
      completion_tokens_median: 50, parse_success_rate: 1, total_cost_usd: 0.02,
    }];
    const stability: StabilityStats[] = [{
      config_id: "c1", trace_file: "analyst-shallow-trace-1.json",
      numeric_cv: 0.15, mode_consistency: null, deal_breaker_true_rate: null,
      topk_consistency: null, baseline_score_diff: null,
      distribution: { "4": 1, "5": 1 },
    }];

    const md = formatReport(results, configStats, stability);
    expect(md).toContain("# Bench: test-bench");
    expect(md).toContain("## 概览");
    expect(md).toContain("| c1 |");              // 概览表有 c1 行
    expect(md).toContain("## 稳定性");
    expect(md).toContain("CV=0.15");            // 稳定性表含 CV
    expect(md).toContain("## 逐样本");
    expect(md).toContain("002167");             // 逐样本块含 ticker
    expect(md).toContain("f=4");                // 分数网格
  });

  it("renders rank phase: top-K in stability + top-ticker grid + baseline top-3", () => {
    const results: BenchResults = {
      bench_name: "rank-bench",
      config_path: "bench/x.json",
      started_at: "2026-06-24T00:00:00Z", finished_at: "2026-06-24T00:01:00Z",
      trace_count: 1, repeats: 1, config_count: 1, total_calls: 1,
      traces: [{ file: "long-ranker-trace-1.json", role: "long-ranker", phase: "rank", ticker: "long-ranker", baseline_duration_ms: 2000, baseline_parsed: { _parse_ok: true, ranked: [{ ticker: "002167", score: 9 }, { ticker: "600519", score: 8 }] } }],
      results: [
        { trace_file: "long-ranker-trace-1.json", config_id: "c1", repeat: 0, ok: true, duration_ms: 500, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, cost_usd: 0.01, raw_content: "{}", parsed: { _parse_ok: true, ranked: [{ ticker: "002167", score: 9 }] } },
      ],
    };
    const configStats: ConfigStats[] = [{
      config_id: "c1", success_rate: 1, success_count: 1, expected_calls: 1,
      duration_median_ms: 500, duration_p90_ms: 500, prompt_tokens_median: 100,
      completion_tokens_median: 50, parse_success_rate: 1, total_cost_usd: 0.01,
    }];
    const stability: StabilityStats[] = [{
      config_id: "c1", trace_file: "long-ranker-trace-1.json",
      numeric_cv: null, mode_consistency: null, deal_breaker_true_rate: null,
      topk_consistency: 1.0, baseline_score_diff: 0.5,
      distribution: { "002167": 1 },
    }];

    const md = formatReport(results, configStats, stability);
    expect(md).toContain("top-K=1.00");          // rank 稳定性列
    expect(md).toContain("trace 基线 top-3");    // rank baseline 行
    expect(md).toContain("top=002167");          // rank 网格用 top ticker
  });

  it("renders failure grid (✗) for failed calls", () => {
    const results: BenchResults = {
      bench_name: "fail-bench",
      config_path: "bench/x.json",
      started_at: "2026-06-24T00:00:00Z", finished_at: "2026-06-24T00:01:00Z",
      trace_count: 1, repeats: 1, config_count: 1, total_calls: 1,
      traces: [{ file: "analyst-shallow-trace-1.json", role: "analyst-shallow", phase: "rebalance", ticker: "002167", baseline_duration_ms: 1000, baseline_parsed: { _parse_ok: true, fitness_score: 4 } }],
      results: [
        { trace_file: "analyst-shallow-trace-1.json", config_id: "c1", repeat: 0, ok: false, duration_ms: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0, raw_content: "", parsed: { _parse_ok: false }, error: "429" },
      ],
    };
    const configStats: ConfigStats[] = [{
      config_id: "c1", success_rate: 0, success_count: 0, expected_calls: 1,
      duration_median_ms: null, duration_p90_ms: null, prompt_tokens_median: null,
      completion_tokens_median: null, parse_success_rate: 0, total_cost_usd: 0,
    }];
    const stability: StabilityStats[] = [{
      config_id: "c1", trace_file: "analyst-shallow-trace-1.json",
      numeric_cv: null, mode_consistency: null, deal_breaker_true_rate: null,
      topk_consistency: null, baseline_score_diff: null,
      distribution: {},
    }];

    const md = formatReport(results, configStats, stability);
    expect(md).toContain("✗");               // 失败网格标记
    expect(md).toContain("0/1");             // 成功率 0/1
    expect(md).toContain("失败 1");          // 头部失败计数
  });
});
