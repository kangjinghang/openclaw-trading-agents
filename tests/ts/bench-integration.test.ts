// tests/ts/bench-integration.test.ts
//
// runBench 端到端集成测试：fixture trace + mock callLLM（无需真实 key/LLM）。
// 验证 selectTraces → runReplay → 聚合 → formatReport → 写产物 的完整链路。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { BenchConfig } from "../../src/watchlist/bench-types";

// vi.mock 被 hoist 到所有 import 之前；工厂内用 vi.fn() 占位，具体行为在 test 里 set
const callLLMMock = vi.fn();
vi.mock("../../src/llm-client", () => ({
  callLLM: callLLMMock,
  RateLimitCoordinator: class {
    async waitIfNeeded() { /* no-op */ }
  },
}));

// bench-runner 在模块加载时已 resolve 了 mock 过的 llm-client，所以这里后 import
const { runBench } = await import("../../src/watchlist/bench-runner");

function writeTrace(dir: string, filename: string, role: string, phase: string, userMsg: string, raw: string) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify({
    trace_id: "x", role, phase,
    request: { model: "m", system_prompt: "sys", user_message: userMsg, temperature: 0, max_tokens: 100 },
    response: { raw_content: raw },
    meta: { timestamp: "t", duration_ms: 1000, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, cost_usd: 0 },
  }));
}

describe("runBench end-to-end (mock callLLM)", () => {
  let tmpWatch: string;
  beforeEach(() => {
    tmpWatch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-e2e-"));
    // 每个 test 重置 mock：analyst 返回 fitness=7 的 JSON
    callLLMMock.mockImplementation(async (_client: unknown, opts: { role: string }) => {
      const content = opts.role.includes("analyst")
        ? JSON.stringify({ thesis: "mock thesis", fitness_score: 7 })
        : JSON.stringify({ overall_risk: "medium", risk_flags: [{ flag: "f1", severity: "中" }], deal_breaker: false });
      return {
        content,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        costUsd: 0.01,
        traceId: `mock-${Date.now()}`,
      };
    });
  });
  afterEach(() => { fs.rmSync(tmpWatch, { recursive: true, force: true }); });

  it("runs full pipeline and writes report.md + results.json", async () => {
    const traceDir = path.join(tmpWatch, "rebalance", "2026-06-23", "traces");
    fs.mkdirSync(traceDir, { recursive: true });
    writeTrace(traceDir, "analyst-shallow-trace-1.json", "analyst-shallow", "rebalance",
      "股票 002167 数据", JSON.stringify({ fitness_score: 5 }));

    const config: BenchConfig = {
      name: "e2e-test",
      traces: { phase: "rebalance", date: "2026-06-23", roles: ["analyst-shallow"] },
      repeats: 2,
      providers: { zhipu: { base_url: "https://x", api_key: "mock-key" } },
      configs: [{ id: "cfg-a", provider: "zhipu", model: "mock-model", temperature: 0, max_tokens: 100 }],
    };

    const outDir = await runBench(config, "bench/e2e.json", tmpWatch, false);

    // 返回产物目录
    expect(outDir).not.toBeNull();
    const reportPath = path.join(outDir!.toString(), "report.md");
    const resultsPath = path.join(outDir!.toString(), "results.json");
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(resultsPath)).toBe(true);

    // results.json 结构
    const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
    expect(results.bench_name).toBe("e2e-test");
    expect(results.total_calls).toBe(2);     // 1 trace × 1 config × 2 repeats
    expect(results.results).toHaveLength(2);
    expect(results.results[0].ok).toBe(true);
    expect(results.results[0].parsed.fitness_score).toBe(7);   // mock 返回的 fitness
    expect(results.results[0].usage.total_tokens).toBe(150);
    // results.json 的 traces 不含 path
    expect(results.traces[0].path).toBeUndefined();
    // callLLM 被调用了 2 次（每个 repeat 一次）
    expect(callLLMMock).toHaveBeenCalledTimes(2);

    // report.md 三段
    const md = fs.readFileSync(reportPath, "utf-8");
    expect(md).toContain("# Bench: e2e-test");
    expect(md).toContain("## 概览");
    expect(md).toContain("## 稳定性");
    expect(md).toContain("## 逐样本");
    expect(md).toContain("f=7");
  });
});
