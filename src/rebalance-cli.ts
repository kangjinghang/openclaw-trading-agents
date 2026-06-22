// src/rebalance-cli.ts
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import OpenAI from "openai";
import { callLLM } from "./llm-client";
import { TraceLogger } from "./trace-logger";
import { loadHoldings } from "./watchlist/holdings-loader";
import { rebalancePipeline } from "./watchlist/rebalancer";
import type { RebalanceLlmCaller } from "./watchlist/rebalancer";
import { formatAnalystPrompt, formatRiskPrompt } from "./watchlist/shallow-analyzer";
import type { ShallowLlmCaller, StockData } from "./watchlist/shallow-analyzer";
import { writeAtomicJson } from "./watchlist/atomic-json";
import { fetchAllStockData } from "./watchlist/data-fetcher";
import type { LastRebalance, RebalancePlanFile } from "./watchlist/rebalance-types";
import type { ScanSummary } from "./watchlist/types";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function argValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

function findLatestScan(watchlistDir: string): string | null {
  const scanRoot = path.join(watchlistDir, "scan");
  if (!fs.existsSync(scanRoot)) return null;
  const dates = fs.readdirSync(scanRoot)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(scanRoot, d, "scan.json")))
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}


async function main() {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;

  if (help) {
    console.log(`Usage: npm run rebalance [-- --date <D> --top-n <N> --model <M> --api-key <K> --base-url <U>]

rebalancer: 读 holdings.json + scan.json → 调仓方案 (plan.json + plan.md)

Options:
  --date <D>         扫描日（默认最新 scan）
  --top-n <N>        从 ranker 取前 N 候选（默认 10）
  --model <M>        模型（默认 glm-4.7）
  --api-key <K>      API key（默认 OPENAI_API_KEY env）
  --base-url <U>     base URL（默认 OPENAI_BASE_URL env）
  --help             显示本帮助
  WATCHLIST_DIR      存储路径（默认 ${DEFAULT_WATCHLIST_DIR}）
`);
    process.exit(0);
  }

  const date = argValue(args, "--date") ?? findLatestScan(watchlistDir);
  if (!date) {
    console.error(`error: 没找到 scan.json，请先跑 npm run rank`);
    process.exit(1);
  }

  // 读输入
  const holdings = loadHoldings(path.join(watchlistDir, "holdings.json"));
  const scanPath = path.join(watchlistDir, "scan", date, "scan.json");
  if (!fs.existsSync(scanPath)) {
    console.error(`error: scan.json 不存在: ${scanPath}`);
    process.exit(1);
  }
  const scan = JSON.parse(fs.readFileSync(scanPath, "utf-8")) as ScanSummary;
  const lastRebalancePath = path.join(watchlistDir, "last_rebalance.json");
  const lastRebalance: LastRebalance | null = fs.existsSync(lastRebalancePath)
    ? JSON.parse(fs.readFileSync(lastRebalancePath, "utf-8"))
    : null;

  // LLM 配置
  const apiKey = argValue(args, "--api-key") ?? process.env.OPENAI_API_KEY;
  const baseUrl = argValue(args, "--base-url") ?? process.env.OPENAI_BASE_URL;
  const model = argValue(args, "--model") ?? "glm-4.7";
  if (!apiKey) {
    console.error(`error: 缺 API key`);
    process.exit(2);
  }
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (baseUrl) clientOpts.baseURL = baseUrl;
  const client = new OpenAI(clientOpts);

  // Trace
  const rebalanceDir = path.join(watchlistDir, "rebalance", date);
  const traceDir = path.join(rebalanceDir, "traces");
  if (fs.existsSync(traceDir)) {
    for (const f of fs.readdirSync(traceDir)) {
      if (f.endsWith(".json")) fs.unlinkSync(path.join(traceDir, f));
    }
  }
  const traceLogger = new TraceLogger(traceDir, `rebalance-${date}`);

  // callers
  const shallowCaller: ShallowLlmCaller = async ({ role, data, analyst }) => {
    const systemPrompt = role === "analyst" ? "A 股综合分析师" : "A 股风险分析师";
    const userMessage = role === "analyst"
      ? formatAnalystPrompt(data)
      : formatRiskPrompt(data, analyst!);
    const result = await callLLM(client, {
      model, systemPrompt, userMessage,
      phase: "rebalance", role: `${role}-shallow`, traceLogger, temperature: 0.3,
    });
    return result.content;
  };
  const rebalanceCaller: RebalanceLlmCaller = async ({ userMessage }) => {
    const result = await callLLM(client, {
      model, systemPrompt: "A 股投资组合管理者", userMessage,
      phase: "rebalance", role: "portfolio-rebalancer", traceLogger, temperature: 0,
    });
    return result.content;
  };

  console.log(`\nrebalancer 开始: ${date}`);
  console.log(`  模型: ${model}`);
  console.log(`  持仓: ${holdings.positions.length} 支 / cash ${(holdings.cash_pct * 100).toFixed(1)}%`);

  // 拉 data（4 Python scripts 并行）
  const topN = parseInt(argValue(args, "--top-n") ?? "10", 10);
  const metasForFetch = [
    ...scan.top_picks.slice(0, topN).map(p => ({
      ticker: p.ticker, name: p.name,
      sector: holdings.positions.find(pos => pos.ticker === p.ticker)?.sector ?? "未分类",
      ranker_thesis: p.reason,
    })),
    ...holdings.positions.map(p => ({ ticker: p.ticker, name: p.name, sector: p.sector })),
  ];
  // 去重
  const seen = new Set<string>();
  const dedupMetas = metasForFetch.filter(m => seen.has(m.ticker) ? false : (seen.add(m.ticker), true));
  console.log(`  拉数据: ${dedupMetas.length} 只股 × 4 scripts（并行 5）`);
  const dataByTicker = await fetchAllStockData(dedupMetas, 5);
  console.log(`  数据就绪: ${dataByTicker.size}/${dedupMetas.length} 只`);

  // 跑 pipeline
  const result = await rebalancePipeline({
    scan, holdings, lastRebalance, currentDate: date,
    shallowCaller, rebalanceCaller, dataByTicker,
    config: { top_n: topN },
  });

  // 写 plan.json
  const planFile: RebalancePlanFile = {
    scan_date: date,
    written_at: new Date().toISOString(),
    status: result.status,
    model,
    tokens: traceLogger.totalTokens,
    holdings_before: holdings,
    candidates: scan.top_picks.slice(0, topN).map(p => ({ ticker: p.ticker, ranker_score: p.score })),
    last_rebalance: lastRebalance,
    reports: result.reports,
    rebalancer_output: result.rebalancer_output,
    constraint_check: result.constraint_check,
    execution_plan: result.execution_plan,
    sector_warnings: result.sector_warnings,
  };
  writeAtomicJson(path.join(rebalanceDir, "plan.json"), planFile);
  writeAtomicJson(path.join(rebalanceDir, "holdings_snapshot.json"), holdings);

  // 更新 last_rebalance.json
  if (result.rebalancer_output.actions.length > 0) {
    const newLast: LastRebalance = {
      date,
      actions: result.rebalancer_output.actions
        .filter(a => a.action !== "HOLD")
        .map(a => ({ action: a.action as "BUY" | "SELL" | "ADD" | "REDUCE", ticker: a.ticker, weight: a.target_weight })),
    };
    writeAtomicJson(path.join(watchlistDir, "last_rebalance.json"), newLast);
  }

  // 摘要
  console.log(`\n=== 调仓结果 ===`);
  console.log(`  status: ${result.status}`);
  console.log(`  reports: ${result.reports.length} / 约束: ${result.constraint_check.passed ? "通过" : "违反"} (revise ${result.constraint_check.revise_count})`);
  if (result.sector_warnings.length > 0) {
    console.log(`  ⚠️ 行业警告:`);
    for (const w of result.sector_warnings) console.log(`    - ${w}`);
  }
  console.log(`  actions:`);
  for (const a of result.rebalancer_output.actions) {
    const sign = a.delta > 0 ? "+" : "";
    console.log(`    [${a.priority}] ${a.action} ${a.ticker} ${(a.current_weight * 100).toFixed(1)}%→${(a.target_weight * 100).toFixed(1)}% (${sign}${(a.delta * 100).toFixed(1)}%)`);
    console.log(`        ${a.reason}`);
  }
  console.log(`\n  execution_sequence:`);
  for (const s of result.execution_plan.execution_sequence) {
    console.log(`    ${s.step}. ${s.action} ${s.ticker} (${s.weight_delta > 0 ? "+" : ""}${(s.weight_delta * 100).toFixed(1)}%) → cash ${(s.est_cash_after * 100).toFixed(1)}%`);
  }
  if (result.execution_plan.warnings.length > 0) {
    console.log(`\n  warnings:`);
    for (const w of result.execution_plan.warnings) console.log(`    - ${w}`);
  }
  console.log(`\n  tokens: ${traceLogger.totalTokens}`);
  console.log(`  输出: ${path.join(rebalanceDir, "plan.json")}`);
}

if (require.main === module) main().catch(e => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
