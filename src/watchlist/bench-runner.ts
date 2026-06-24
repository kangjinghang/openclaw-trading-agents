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
  coefficientOfVariation, modeConsistency,
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
 * 校验配置结构（不碰 key）：phase 合法、repeats>0、provider 引用存在。
 * 不展开 $ENV，所以 dry-run 也能用（无需真实 key）。
 */
export function validateConfigStructure(config: BenchConfig): void {
  if (config.repeats <= 0) throw new Error("bench: repeats 必须 > 0");
  if (config.traces.phase !== "rank" && config.traces.phase !== "rebalance") {
    throw new Error(`bench: traces.phase 只能是 rank|rebalance，得到 "${config.traces.phase}"`);
  }
  for (const c of config.configs) {
    if (!config.providers[c.provider]) {
      throw new Error(`bench: config "${c.id}" 引用了不存在的 provider "${c.provider}"`);
    }
  }
}

/**
 * 校验配置完整性 + 展开 $ENV。结构校验通过后，把每个 provider 的 api_key 展开。
 * 真实 run 用这个（强制 key 存在）；dry-run 用 validateConfigStructure。
 */
export function validateConfig(config: BenchConfig): Record<string, BenchProvider & { api_key: string }> {
  validateConfigStructure(config);
  const expanded: Record<string, BenchProvider & { api_key: string }> = {};
  for (const [name, p] of Object.entries(config.providers)) {
    expanded[name] = { base_url: p.base_url, api_key: expandApiKey(p.api_key) };
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
    if (Array.isArray(d.risk_flags)) {
      // 只保留结构合法的 flag 项（flag/severity 是字符串），避免脏 JSON 让类型失真
      out.risk_flags = d.risk_flags
        .filter((f: any) => f && typeof f.flag === "string" && typeof f.severity === "string")
        .map((f: any) => ({ flag: f.flag, severity: f.severity }));
    }
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
    // role 作为文件名前缀（= `${role}-trace-...`）。用 `${r}-` 精确匹配，
    // 避免 "analyst" 误匹配到 "analyst-shallow"（roles 是完整 role 名）。
    files = files.filter(f => sel.roles!.some(r => f.startsWith(r + "-")));
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

/**
 * 按 (config × trace) 聚合稳定性。按 trace.phase 和 role 决定用哪个指标：
 * - rank: topK 一致率 + baseline 分数差；numeric_cv/mode=null
 * - analyst-shallow: fitness_score 的 CV；topk/mode=null
 * - risk-shallow: overall_risk 众数一致率 + risk_flags 数量的 CV
 */
export function computeStability(
  configId: string,
  trace: SelectedTrace,
  calls: BenchCallResult[],
): StabilityStats {
  const okCalls = calls.filter(c => c.ok && c.parsed._parse_ok);
  const distribution: Record<string, number> = {};

  let numeric_cv: number | null = null;
  let mode_consistency: number | null = null;
  let deal_breaker_true_rate: number | null = null;
  let topk_consistency: number | null = null;
  let baseline_score_diff: number | null = null;

  if (trace.phase === "rank") {
    const lists = okCalls.map(c => (c.parsed.ranked || []).map(r => r.ticker));
    topk_consistency = topKConsistency(lists, 3);
    if (trace.baseline_parsed.ranked && trace.baseline_parsed.ranked.length > 0) {
      const diffs = okCalls
        .map(c => meanAbsScoreDiff(trace.baseline_parsed.ranked!, c.parsed.ranked || []))
        .filter((v): v is number => v !== null);
      baseline_score_diff = diffs.length > 0 ? diffs.reduce((s, v) => s + v, 0) / diffs.length : null;
    }
    // rank 的 ticker 分布
    for (const c of okCalls) {
      for (const r of c.parsed.ranked || []) {
        distribution[r.ticker] = (distribution[r.ticker] || 0) + 1;
      }
    }
  } else if (trace.role.includes("risk")) {
    const risks = okCalls.map(c => c.parsed.overall_risk || "unknown");
    mode_consistency = modeConsistency(risks);
    const flagCounts = okCalls.map(c => (c.parsed.risk_flags || []).length);
    numeric_cv = coefficientOfVariation(flagCounts);
    // deal_breaker true 占比（true 出现次数 / 总数）
    const dealBreakers = okCalls
      .map(c => c.parsed.deal_breaker)
      .filter((v): v is boolean => typeof v === "boolean");
    deal_breaker_true_rate = dealBreakers.length > 0
      ? dealBreakers.filter(Boolean).length / dealBreakers.length
      : null;
    for (const r of risks) distribution[r] = (distribution[r] || 0) + 1;
  } else {
    // analyst-shallow
    const scores = okCalls
      .map(c => c.parsed.fitness_score)
      .filter((v): v is number => typeof v === "number");
    numeric_cv = coefficientOfVariation(scores);
    for (const s of scores.map(String)) distribution[s] = (distribution[s] || 0) + 1;
  }

  return {
    config_id: configId,
    trace_file: trace.file,
    numeric_cv, mode_consistency, deal_breaker_true_rate, topk_consistency, baseline_score_diff,
    distribution,
  };
}

/** 秒格式化 */
function fmtMs(ms: number | null): string {
  if (ms === null) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 格式化 report.md：概览表 + 稳定性表 + 逐样本块。
 * 逐样本块只放分数网格，thesis/ranked 全文不贴（在 results.json）。
 */
export function formatReport(
  results: BenchResults,
  configStats: ConfigStats[],
  stability: StabilityStats[],
): string {
  const lines: string[] = [];
  const failed = results.results.filter(r => !r.ok).length;
  lines.push(`# Bench: ${results.bench_name}`);
  lines.push(`${results.trace_count} traces × ${results.repeats} repeats × ${results.config_count} configs = ${results.total_calls} calls · 失败 ${failed}`);
  lines.push("");

  // ── 概览 ──
  lines.push("## 概览（按 config 汇总）");
  lines.push("");
  lines.push("| config | 成功率 | 耗时中位数 | p90 耗时 | prompt tok 中位 | completion tok 中位 | 解析成功率 | cost |");
  lines.push("|--------|--------|-----------|---------|----------------|--------------------|-----------|------|");
  for (const s of configStats) {
    const parsePct = s.parse_success_rate > 0 ? `${Math.round(s.parse_success_rate * 100)}%` : "-";
    lines.push(`| ${s.config_id} | ${s.success_count}/${s.expected_calls} | ${fmtMs(s.duration_median_ms)} | ${fmtMs(s.duration_p90_ms)} | ${s.prompt_tokens_median ?? "-"} | ${s.completion_tokens_median ?? "-"} | ${parsePct} | $${s.total_cost_usd.toFixed(4)} |`);
  }
  lines.push("");

  // ── 稳定性 ──
  lines.push("## 稳定性（按 config × trace 汇总）");
  lines.push("");
  const traceFiles = results.traces.map(t => t.file);
  const configIds = configStats.map(s => s.config_id);
  const isRank = results.traces.some(t => t.phase === "rank");
  const metricLabel = isRank ? "top-K 一致率" : "fitness CV / risk 众数";
  const headerCells = traceFiles.map(f => {
    const t = results.traces.find(x => x.file === f);
    return t?.ticker ?? f;
  });
  lines.push(`| config | ${headerCells.join(" | ")} |`);
  lines.push(`|--------|${traceFiles.map(() => "----").join("|")}|`);
  for (const cid of configIds) {
    const cells = traceFiles.map(tf => {
      const s = stability.find(x => x.config_id === cid && x.trace_file === tf);
      if (!s) return "-";
      if (isRank) return s.topk_consistency !== null ? `top-K=${s.topk_consistency.toFixed(2)}` : "-";
      if (s.mode_consistency !== null) {
        const db = s.deal_breaker_true_rate !== null ? ` / dealbreaker=${(s.deal_breaker_true_rate * 100).toFixed(0)}%` : "";
        return `众数=${(s.mode_consistency * 100).toFixed(0)}%${db}`;
      }
      return s.numeric_cv !== null ? `CV=${s.numeric_cv.toFixed(2)}` : "-";
    });
    lines.push(`| ${cid} | ${cells.join(" | ")} |`);
  }
  lines.push(`（指标：${metricLabel}；数值越小越稳定 / 越大越一致）`);
  lines.push("");

  // ── 逐样本 ──
  lines.push("## 逐样本");
  lines.push("");
  for (const trace of results.traces) {
    lines.push(`### ${trace.ticker} (${trace.role})`);
    if (trace.baseline_parsed.fitness_score !== undefined) {
      lines.push(`trace 基线 fitness=${trace.baseline_parsed.fitness_score} (${fmtMs(trace.baseline_duration_ms)})`);
    } else if (trace.baseline_parsed.overall_risk) {
      lines.push(`trace 基线 risk=${trace.baseline_parsed.overall_risk} (${fmtMs(trace.baseline_duration_ms)})`);
    } else if (trace.baseline_parsed.ranked && trace.baseline_parsed.ranked.length > 0) {
      const top3 = trace.baseline_parsed.ranked.slice(0, 3).map((r, i) => `${i + 1}.${r.ticker}`).join(" ");
      lines.push(`trace 基线 top-3: ${top3} (${fmtMs(trace.baseline_duration_ms)})`);
    }
    // 分数网格表头
    let header = "| config |";
    let sep = "|--------|";
    for (let r = 0; r < results.repeats; r++) {
      header += ` rep${r} |`;
      sep += "----|";
    }
    lines.push(header);
    lines.push(sep);
    for (const cid of configIds) {
      let row = `| ${cid} |`;
      for (let r = 0; r < results.repeats; r++) {
        const call = results.results.find(x => x.trace_file === trace.file && x.config_id === cid && x.repeat === r);
        if (!call) row += " - |";
        else if (!call.ok) row += " ✗ |";
        else if (call.parsed.fitness_score !== undefined) row += ` f=${call.parsed.fitness_score} |`;
        else if (call.parsed.overall_risk) row += ` ${call.parsed.overall_risk.slice(0, 3)} |`;
        else if (call.parsed.ranked && call.parsed.ranked.length > 0) row += ` top=${call.parsed.ranked[0]?.ticker ?? "?"} |`;
        else row += " ? |";
      }
      lines.push(row);
    }
    lines.push("（thesis / ranked 全文见 results.json 对应条目）");
    lines.push("");
  }

  return lines.join("\n");
}

/** 从 trace 文件读原始 system_prompt + user_message（回放必须用原 prompt，绝不重新生成）。 */
function readTracePrompt(trace: SelectedTrace): { system: string; user: string } {
  const t = JSON.parse(fs.readFileSync(trace.path, "utf-8"));
  return {
    system: t.request?.system_prompt ?? "",
    user: t.request?.user_message ?? "",
  };
}

/**
 * 生产用 caller：用 callLLM 回放单条 trace。
 * 给整个 run 一个临时 TraceLogger（写 tmpdir，仅满足 callLLM 签名，bench 不读其 trace）。
 * 同 provider 的 config 共享一个 RateLimitCoordinator（429 协调）。
 *
 * prompt 按 trace 文件名缓存（同一 trace 的所有 config × repeat 读同一份文件，
 * 不必每次重读 12KB 的 rank user_message）。
 */
export function makeCaller(
  clients: Record<string, OpenAI>,
  coordinators: Record<string, RateLimitCoordinator>,
): { caller: BenchCaller; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-trace-"));
  const traceLogger = new TraceLogger(tmpDir, "bench");
  const promptCache = new Map<string, { system: string; user: string }>();

  const caller: BenchCaller = async ({ trace, config }): Promise<BenchCallOutcome> => {
    const client = clients[config.provider];
    const coordinator = coordinators[config.provider];
    const start = Date.now();
    try {
      if (coordinator) await coordinator.waitIfNeeded();
      // prompt 原样从 trace 读——绝不重新生成；按文件名缓存避免重复读盘
      let prompt = promptCache.get(trace.file);
      if (!prompt) {
        prompt = readTracePrompt(trace);
        promptCache.set(trace.file, prompt);
      }
      const result = await callLLM(client, {
        model: config.model,
        systemPrompt: prompt.system,
        userMessage: prompt.user,
        phase: trace.phase,
        role: trace.role,
        traceLogger,
        rateLimitCoordinator: coordinator,
        ...(config.thinking ? { thinking: config.thinking } : {}),
        ...(config.responseFormat ? { responseFormat: config.responseFormat } : {}),
        temperature: config.temperature,
        maxTokens: config.max_tokens ?? LLM_DEFAULT_MAX_TOKENS,
      });
      return {
        ok: result.content.trim().length > 0,
        duration_ms: Date.now() - start,
        usage: result.usage,
        cost_usd: result.costUsd,
        raw_content: result.content,
        parsed: parseOutput(result.content),
      };
    } catch (e) {
      return {
        ok: false, duration_ms: Date.now() - start,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost_usd: 0, raw_content: "", parsed: { _parse_ok: false },
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };

  return { caller, tmpDir };
}

/**
 * bench 总入口：选 trace → 造 clients/coordinators → 回放 → 聚合 → 写产物。
 * 返回产物目录路径。dryRun=true 时只打印选中 trace 和调用数，不调 LLM。
 */
export async function runBench(
  config: BenchConfig,
  configPath: string,
  watchlistDir: string,
  dryRun: boolean = false,
): Promise<string | null> {
  // dry-run 只校验结构（不需要真实 key）；真实 run 校验结构 + 展开 key
  validateConfigStructure(config);
  const traces = selectTraces(watchlistDir, config.traces);

  console.log(`\nbench: ${config.name}`);
  console.log(`  traces: ${traces.length}（${config.traces.phase}${config.traces.date ? ` / ${config.traces.date}` : " / 最新"}）`);
  console.log(`  configs: ${config.configs.length} × repeats ${config.repeats} = ${traces.length * config.configs.length * config.repeats} 次调用`);

  if (traces.length === 0) {
    console.error(`  error: 没有匹配的 trace，检查 traces.phase/date/roles`);
    return null;
  }

  if (dryRun) {
    console.log(`  [dry-run] 不调用 LLM。选中 trace:`);
    for (const t of traces) console.log(`    - ${t.file} (${t.role}, ticker=${t.ticker})`);
    return null;
  }

  // 真实 run：展开 key + 造 clients/coordinators（按 provider 隔离）
  const providers = validateConfig(config);
  const clients: Record<string, OpenAI> = {};
  const coordinators: Record<string, RateLimitCoordinator> = {};
  for (const [name, p] of Object.entries(providers)) {
    clients[name] = new OpenAI({ apiKey: p.api_key, baseURL: p.base_url });
    coordinators[name] = new RateLimitCoordinator();
  }

  const startedAt = new Date().toISOString();
  const { caller, tmpDir } = makeCaller(clients, coordinators);
  try {
    const callResults = await runReplay(traces, config.configs, config.repeats, caller);
    const finishedAt = new Date().toISOString();

    // 聚合
    const expectedPerConfig = traces.length * config.repeats;
    const configStats = config.configs.map(c =>
      summarizeConfigStats(c.id, callResults.filter(r => r.config_id === c.id), expectedPerConfig));
    const stability: StabilityStats[] = [];
    for (const c of config.configs) {
      for (const t of traces) {
        stability.push(computeStability(c.id, t, callResults.filter(r => r.config_id === c.id && r.trace_file === t.file)));
      }
    }

    const results: BenchResults = {
      bench_name: config.name,
      config_path: configPath,
      started_at: startedAt,
      finished_at: finishedAt,
      trace_count: traces.length,
      repeats: config.repeats,
      config_count: config.configs.length,
      total_calls: callResults.length,
      traces: traces.map(({ path: _path, ...rest }) => rest),  // 剥掉 path（results.json 不含完整路径）
      results: callResults,
    };

    // 写产物
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(watchlistDir, "bench", `${config.name}-${ts}`);
    fs.mkdirSync(outDir, { recursive: true });
    writeAtomicJson(path.join(outDir, "results.json"), results);
    fs.writeFileSync(path.join(outDir, "report.md"), formatReport(results, configStats, stability), "utf-8");

    console.log(`\n=== 完成 ===`);
    console.log(`  调用: ${callResults.length}（失败 ${callResults.filter(r => !r.ok).length}）`);
    console.log(`  输出: ${path.join(outDir, "report.md")}`);
    console.log(`  输出: ${path.join(outDir, "results.json")}`);
    return outDir;
  } finally {
    // 清理临时 TraceLogger 目录（makeCaller 的 mkdtempSync 产物）。
    // 即使正常跑完也不清理就会泄漏——callLLM 写的 trace 文件 bench 用不到。
    // 失败/超时也走 finally，不留残渣。
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻塞主流程（tmpdir 最终会被 OS 清）
    }
  }
}



