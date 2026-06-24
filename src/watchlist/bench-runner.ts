// src/watchlist/bench-runner.ts
//
// bench 回放执行器：配置解析 → trace 选择 → 回放（复用 callLLM）→ 统计 → 写产物。
// 解析/选择/格式化是纯逻辑或薄 IO，回放是核心。

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";
import { callLLM, RateLimitCoordinator } from "../llm-client";
import { TraceLogger } from "../trace-logger";
import { LLM_DEFAULT_MAX_TOKENS } from "../constants";
import { writeAtomicJson } from "./atomic-json";
import {
  percentile, coefficientOfVariation, modeConsistency,
  topKConsistency, meanAbsScoreDiff, summarizeConfigStats,
} from "./bench-stats";
import type {
  BenchConfig, BenchProvider, SelectedTrace, BenchCallResult,
  BenchResults, ParsedOutput, ConfigStats, StabilityStats, BenchConfigEntry,
} from "./bench-types";

/**
 * 展开 api_key："$ENV" 前缀读环境变量，否则当字面量。
 * 环境变量未设时抛错（避免静默用空 key 调出 401）。
 */
export function expandApiKey(raw: string): string {
  if (raw.startsWith("$")) {
    const name = raw.slice(1);
    const val = process.env[name];
    if (!val) throw new Error(`bench: 环境变量 ${name} 未设置（api_key 引用了它）`);
    return val;
  }
  return raw;
}

/**
 * 校验配置完整性：provider 引用存在、phase 合法、repeats>0。
 * 同时把 $ENV 展开（副作用：可能抛错）。返回展开后的 providers。
 */
export function validateConfig(config: BenchConfig): Record<string, BenchProvider & { api_key: string }> {
  if (config.repeats <= 0) throw new Error("bench: repeats 必须 > 0");
  if (config.traces.phase !== "rank" && config.traces.phase !== "rebalance") {
    throw new Error(`bench: traces.phase 只能是 rank|rebalance，得到 "${config.traces.phase}"`);
  }
  const expanded: Record<string, BenchProvider & { api_key: string }> = {};
  for (const [name, p] of Object.entries(config.providers)) {
    expanded[name] = { base_url: p.base_url, api_key: expandApiKey(p.api_key) };
  }
  for (const c of config.configs) {
    if (!expanded[c.provider]) {
      throw new Error(`bench: config "${c.id}" 引用了不存在的 provider "${c.provider}"`);
    }
  }
  return expanded;
}

/**
 * 从 LLM 原始输出提取 JSON 并解析为 ParsedOutput。
 * 容忍 ```json 围栏和前后噪声文本。解析失败返回 { _parse_ok: false }。
 */
export function parseOutput(rawContent: string): ParsedOutput {
  const fail: ParsedOutput = { _parse_ok: false };
  const trimmed = rawContent.trim();
  let jsonStr: string | null = null;

  // 1. 直接是 JSON
  if (trimmed.startsWith("{")) {
    jsonStr = trimmed;
  } else {
    // 2. 正则提取首个 {...}（容忍围栏/噪声）
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) jsonStr = m[0];
  }
  if (!jsonStr) return fail;

  try {
    const d = JSON.parse(jsonStr);
    const out: ParsedOutput = { _parse_ok: true };
    if (Array.isArray(d.ranked)) {
      out.ranked = d.ranked
        .filter((r: any) => r && typeof r.ticker === "string" && typeof r.score === "number")
        .map((r: any) => ({ ticker: r.ticker, score: r.score }));
    }
    if (typeof d.fitness_score === "number") out.fitness_score = d.fitness_score;
    if (typeof d.thesis === "string") out.thesis = d.thesis;
    if (typeof d.overall_risk === "string") out.overall_risk = d.overall_risk;
    if (Array.isArray(d.risk_flags)) out.risk_flags = d.risk_flags;
    if (typeof d.deal_breaker === "boolean") out.deal_breaker = d.deal_breaker;
    return out;
  } catch {
    return fail;
  }
}

/**
 * 从 shallow trace 的 user_message 提取 ticker（A 股 6 位代码）。
 * rank trace 不用此函数（多股摘要，用 role 标识）。
 */
export function extractTicker(userMessage: string): string {
  const m = userMessage.match(/(?:(?<=ticker|股票)[^A-Z0-9]*)([A-Z0-9]{6,8})/);
  // m[1] = 捕获组（纯代码）；m[0] 含 lookbehind 后的噪声（如 ": "），用 m[1]
  return m && m[1] ? m[1] : "unknown";
}

/**
 * 按 phase/date/roles 选择 trace 文件，解析元信息。
 * phase=rank → scan/{date}/traces/；phase=rebalance → rebalance/{date}/traces/。
 * date 缺省取该 phase 下最新日期。
 */
export function selectTraces(
  watchlistDir: string,
  sel: { phase: "rank" | "rebalance"; date?: string; roles?: string[]; limit?: number },
): SelectedTrace[] {
  const phaseRoot = sel.phase === "rank" ? "scan" : "rebalance";
  const root = path.join(watchlistDir, phaseRoot);

  let date = sel.date;
  if (!date) {
    const dates = fs.existsSync(root)
      ? fs.readdirSync(root)
          .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(root, d, "traces")))
          .sort()
      : [];
    if (dates.length === 0) return [];
    date = dates[dates.length - 1];
  }

  const traceDir = path.join(root, date, "traces");
  if (!fs.existsSync(traceDir)) return [];

  let files = fs.readdirSync(traceDir).filter(f => f.endsWith(".json")).sort();
  if (sel.roles && sel.roles.length > 0) {
    files = files.filter(f => sel.roles!.some(r => f.startsWith(r + "-") || f.startsWith(r)));
  }
  if (sel.limit && sel.limit > 0) files = files.slice(0, sel.limit);

  return files.map(file => {
    const fp = path.join(traceDir, file);
    const trace = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const role: string = trace.role || file.split("-trace-")[0];
    const ticker = sel.phase === "rank"
      ? role   // rank: 多股摘要，用 role（long-ranker/short-ranker）标识
      : extractTicker(trace.request?.user_message || "");
    return {
      file,
      path: fp,
      role,
      phase: sel.phase,
      ticker,
      baseline_duration_ms: trace.meta?.duration_ms ?? 0,
      baseline_parsed: parseOutput(trace.response?.raw_content || ""),
    };
  });
}

/** 单次回放的入参（传给 caller） */
export interface BenchCallArgs {
  trace: SelectedTrace;
  config: BenchConfigEntry;
  configId: string;
  repeat: number;
}

/** 单次回放的返回（caller 实现生产=callLLM，测试=mock）。 */
export interface BenchCallOutcome {
  ok: boolean;
  duration_ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  cost_usd: number;
  raw_content: string;
  parsed: ParsedOutput;
  error?: string;
}

/** 注入点：runner 不直接调 callLLM，由 CLI 注入（生产）或测试 mock。 */
export type BenchCaller = (args: BenchCallArgs) => Promise<BenchCallOutcome>;

/**
 * 回放执行器：对每个 trace × config × repeat 调 caller。
 * 失败不中断——单次失败记 ok:false，继续后续。
 * 不同 config 间并行（Promise.all），同 config 内 traces×repeats 串行
 * （caller 内部限流协调负责同 provider 退避）。
 */
export async function runReplay(
  traces: SelectedTrace[],
  configs: BenchConfigEntry[],
  repeats: number,
  caller: BenchCaller,
): Promise<BenchCallResult[]> {
  const results: BenchCallResult[] = [];

  await Promise.all(configs.map(async (config) => {
    for (const trace of traces) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        try {
          const outcome = await caller({ trace, config, configId: config.id, repeat });
          results.push({
            trace_file: trace.file,
            config_id: config.id,
            repeat,
            ok: outcome.ok,
            duration_ms: outcome.duration_ms,
            usage: outcome.usage,
            cost_usd: outcome.cost_usd,
            raw_content: outcome.raw_content,
            parsed: outcome.parsed,
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        } catch (e) {
          // caller 自身抛错（不该发生，但兜底）——记失败继续
          results.push({
            trace_file: trace.file, config_id: config.id, repeat,
            ok: false, duration_ms: 0,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            cost_usd: 0, raw_content: "", parsed: { _parse_ok: false },
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }));

  return results;
}

