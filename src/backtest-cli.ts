// src/backtest-cli.ts
//
// 趋势策略回测（连续持仓模拟版）：
// 逐日累积持仓，模拟真实逐日运行，输出组合 NAV 曲线 + 交易记录 + 汇总指标。
//
// 用法：
//   node dist/backtest-cli.js --api-key <KEY> [--dates 2026-06-17,2026-06-18] [--top-n 10]
// 不传 --dates 则回测所有有 scan 数据的日期。

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";
import { callLLM } from "./llm-client";
import { TraceLogger } from "./trace-logger";
import { execSkillScript } from "./exec-python";
import {
  rebalancePipeline,
  type RebalanceLlmCaller,
} from "./watchlist/rebalancer";
import {
  formatAnalystPrompt,
  formatRiskPrompt,
  type ShallowLlmCaller,
} from "./watchlist/shallow-analyzer";
import { fetchAllStockData } from "./watchlist/data-fetcher";
import type { Action, StockReport } from "./watchlist/rebalance-types";
import type { ScanSummary } from "./watchlist/types";
import { PositionSimulator, type BacktestResults } from "./watchlist/backtest-simulator";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function argValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

// ── K 线取数 + 价格查询（带内存缓存，避免重复拉取） ──────────────────────

interface KlineBar { date: string; close: number; }
const klineCache = new Map<string, KlineBar[]>();  // ticker → 日 K

/** 拉指定 ticker 的日 K（120 根），缓存结果。 */
async function fetchKline(ticker: string): Promise<KlineBar[]> {
  const cached = klineCache.get(ticker);
  if (cached) return cached;
  try {
    const code = ticker.replace(/^(SH|SZ)/, "");
    const r = await execSkillScript("trading-kline", "kline", PROJECT_ROOT, ["--ticker", code, "--count", "120"]);
    if (!r.success || !r.data) return [];
    const bars = (r.data as any).data as KlineBar[] | undefined;
    if (!Array.isArray(bars) || bars.length === 0) return [];
    const normalized = bars.map(b => ({ date: String(b.date).slice(0, 10), close: Number(b.close) }));
    klineCache.set(ticker, normalized);
    return normalized;
  } catch {
    return [];
  }
}

/** 查指定 ticker 在指定日期的收盘价。找不到返回 null。 */
async function lookupPrice(ticker: string, date: string): Promise<number | null> {
  const bars = await fetchKline(ticker);
  // 精确匹配
  const exact = bars.find(b => b.date === date);
  if (exact) return exact.close;
  // 找最近的交易日（date 可能是非交易日，取之前最近的）
  const before = bars.filter(b => b.date <= date).sort((a, b) => b.date.localeCompare(a.date));
  if (before.length > 0) return before[0].close;
  return null;
}

// ── 格式化输出 ──────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, suffix = "%"): string {
  if (n === null || n === undefined) return "N/A";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}${suffix}`;
}

function renderResults(results: BacktestResults): string {
  const lines: string[] = [];

  // NAV 曲线
  lines.push("\n═══ 每日 NAV ═══");
  for (const snap of results.navHistory) {
    const actionsStr = snap.actions.length > 0 ? ` | ${snap.actions.join(", ")}` : " | (全 HOLD)";
    lines.push(
      `Day ${snap.date}: NAV ${snap.nav.toFixed(4)} (${fmt(snap.dailyReturnPct)}) `
      + `cash ${(snap.cashPct * 100).toFixed(0)}% 持仓${snap.positionCount}只${actionsStr}`,
    );
  }

  // 交易记录
  lines.push("\n═══ 交易记录 ═══");
  const closedTrades = results.trades.filter(t => t.exitDate !== null);
  const openTrades = results.trades.filter(t => t.exitDate === null);

  if (closedTrades.length > 0) {
    lines.push("已平仓：");
    for (const t of closedTrades) {
      const win = (t.returnPct ?? 0) > 0 ? "✓" : "✗";
      lines.push(
        `  ${win} ${t.ticker} ${t.name}: ${t.entryDate}→${t.exitDate} `
        + `(持${t.holdDays}天) ${fmt(t.returnPct)} @${t.entryPrice.toFixed(2)}→${t.exitPrice?.toFixed(2)}`,
      );
    }
  }
  if (openTrades.length > 0) {
    lines.push("未平仓（回测期末仍持有）：");
    for (const t of openTrades) {
      const win = (t.returnPct ?? 0) > 0 ? "✓" : "✗";
      lines.push(
        `  ${win} ${t.ticker} ${t.name}: ${t.entryDate}→期末 `
        + `(持${t.holdDays}天) ${fmt(t.returnPct)} @${t.entryPrice.toFixed(2)}`,
      );
    }
  }

  // 汇总
  const s = results.summary;
  lines.push("\n═══ 回测汇总 ═══");
  lines.push(`期间: ${s.startDate} → ${s.endDate}`);
  lines.push(`总收益: ${fmt(s.totalReturnPct)} | 最大回撤: ${fmt(s.maxDrawdownPct)}`);
  lines.push(`已平仓交易: ${s.tradeCount} 笔（胜率 ${(s.winRate * 100).toFixed(0)}%）| 平均持仓 ${s.avgHoldDays.toFixed(1)} 天`);
  lines.push(`平均盈利: ${fmt(s.avgWinPct)} | 平均亏损: ${fmt(s.avgLossPct)}`);

  return lines.join("\n");
}

// ── 主入口 ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`趋势策略回测（连续持仓模拟）：逐日累积持仓，看组合真实收益

用法:
  node dist/backtest-cli.js --api-key <KEY> [--dates D1,D2] [--top-n N]

选项:
  --api-key <K>     LLM API key（或 OPENAI_API_KEY env）
  --base-url <U>    base URL（默认 OPENAI_BASE_URL env）
  --model <M>       模型（默认 glm-5-turbo）
  --dates <D>       回测日期，逗号分隔（默认所有有 scan 的日期）
  --top-n <N>       候选数（默认 10）
  --help            显示本帮助
  WATCHLIST_DIR     存储路径（默认 ${DEFAULT_WATCHLIST_DIR}）

说明：
  - 逐日累积：D 日持仓带到 D+1，模拟真实逐日运行
  - 权重漂移：按每日收盘价重算持仓权重（涨了的股权重变大）
  - 空仓起步：第一天从 100% 现金开始`);
    process.exit(0);
  }

  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;
  const apiKey = argValue(args, "--api-key") ?? process.env.OPENAI_API_KEY;
  const baseUrl = argValue(args, "--base-url") ?? process.env.OPENAI_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4";
  const model = argValue(args, "--model") ?? "glm-5-turbo";
  const topN = Math.max(1, parseInt(argValue(args, "--top-n") ?? "10", 10) || 10);

  if (!apiKey) {
    console.error("error: 缺 API key");
    process.exit(2);
  }

  // 确定回测日期
  let dates: string[];
  const datesArg = argValue(args, "--dates");
  if (datesArg) {
    dates = datesArg.split(",").map(d => d.trim()).filter(Boolean).sort();
  } else {
    const scanDir = path.join(watchlistDir, "scan");
    if (!fs.existsSync(scanDir)) {
      console.error(`error: scan 目录不存在: ${scanDir}`);
      process.exit(1);
    }
    dates = fs.readdirSync(scanDir)
      .filter(d => fs.existsSync(path.join(scanDir, d, "scan.json")))
      .sort();
  }
  if (dates.length === 0) {
    console.error("error: 没有找到可回测的日期");
    process.exit(1);
  }

  console.log(`回测: ${dates.join(" → ")}（top-${topN}，连续持仓模拟，模型 ${model}）`);

  // LLM client + callers
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (baseUrl) clientOpts.baseURL = baseUrl;
  const client = new OpenAI(clientOpts);
  const traceLogger = new TraceLogger(path.join(os.tmpdir(), "backtest-traces"), "backtest");

  const shallowCaller: ShallowLlmCaller = async ({ role, data, analyst }) => {
    const systemPrompt = role === "analyst" ? "A 股趋势跟随分析师" : "A 股趋势策略风险分析师";
    const userMessage = role === "analyst"
      ? formatAnalystPrompt(data)
      : formatRiskPrompt(data, analyst!);
    const result = await callLLM(client, {
      model, systemPrompt, userMessage,
      phase: "rebalance", role: `${role}-backtest`, traceLogger, temperature: 0,
      thinking: { type: "disabled" },
      responseFormat: { type: "json_object" },
    });
    return result.content;
  };
  const rebalanceCaller: RebalanceLlmCaller = async ({ userMessage }) => {
    const result = await callLLM(client, {
      model, systemPrompt: "A 股趋势跟随策略组合管理者", userMessage,
      phase: "rebalance", role: "portfolio-backtest", traceLogger, temperature: 0,
      thinking: { type: "disabled" },
    });
    return result.content;
  };

  // 持仓模拟器
  const simulator = new PositionSimulator(lookupPrice);

  // 逐日回测
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const scanPath = path.join(watchlistDir, "scan", date, "scan.json");
    if (!fs.existsSync(scanPath)) {
      console.log(`跳过 ${date}: scan.json 不存在`);
      continue;
    }
    const scan = JSON.parse(fs.readFileSync(scanPath, "utf-8")) as ScanSummary;

    // 1. 用当日收盘价重算权重漂移（返回价格缓存，后续复用）
    const priceMap = await simulator.normalizeWeights(date);

    // 2. 获取当前持仓状态（复用价格缓存）
    const holdings = await simulator.toHoldings(date, priceMap);
    const lastRebalance = simulator.getLastRebalance();

    // 3. 构造候选 metas（scan top + 持仓股）
    const top = scan.top_picks.slice(0, topN);
    const metas = [
      ...top.map(p => ({
        ticker: p.ticker, name: p.name,
        sector: holdings.positions.find(pos => pos.ticker === p.ticker)?.sector ?? "未分类",
        ranker_thesis: p.reason,
      })),
    ];
    // 确保持仓股都在 metas 里（fetchAllStockData 需要）
    for (const pos of holdings.positions) {
      if (!metas.find(m => m.ticker === pos.ticker)) {
        metas.push({ ticker: pos.ticker, name: pos.name, sector: pos.sector, ranker_thesis: "" });
      }
    }

    console.log(`\nDay ${date}（${scan.top_picks.length} picks，持仓 ${holdings.positions.length} 只）...`);

    // 4. 拉数据 + 跑 rebalance
    const { dataByTicker } = await fetchAllStockData(metas, 5, { date });
    const result = await rebalancePipeline({
      scan, holdings, lastRebalance, currentDate: date,
      shallowCaller, rebalanceCaller, dataByTicker,
    });

    // 检查 rebalance 是否成功（失败则 HOLD 不更新持仓，但记录 NAV）
    if (result.status !== "ok") {
      console.log(`  ⚠️ rebalance ${result.status}，持仓不变`);
    } else {
      // 5. 更新持仓（复用价格缓存；BUY 新股会补查价格）
      const reportsByTicker = new Map<string, { fitness_score: number; name: string; sector: string }>();
      for (const r of result.reports as StockReport[]) {
        reportsByTicker.set(r.ticker, { fitness_score: r.fitness_score, name: r.name, sector: r.sector });
      }
      await simulator.applyPlan(result, date, reportsByTicker, priceMap);
    }

    // 6. 记录 NAV（prevNav 取 navHistory 最后一条的真实净值，而非重算）
    const prevNav = simulator.getPrevNav();
    await simulator.recordNav(date, result.rebalancer_output.actions as Action[], prevNav, priceMap);
  }

  // 期末：平仓未结头寸（记为未平仓交易）。复用最后一天的 priceMap（已在循环末尾）。
  const lastDate = dates[dates.length - 1];
  await simulator.closeOpenPositions(lastDate);

  // 输出结果
  const results = simulator.getResults();
  console.log(renderResults(results));

  // 持久化
  const backtestDir = path.join(watchlistDir, "backtest");
  fs.mkdirSync(backtestDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(backtestDir, `run-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });

  // result.json（结构化）
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(results, null, 2), "utf-8");

  // report.md（人类可读）
  const md = [
    `# 趋势策略回测报告`,
    ``,
    `> 日期: ${dates.join(" → ")} | 模型: ${model} | top-${topN} | 连续持仓模拟`,
    `> 生成时间: ${new Date().toISOString()}`,
    ``,
    renderResults(results),
  ].join("\n");
  fs.writeFileSync(path.join(runDir, "report.md"), md, "utf-8");

  console.log(`\n报告已保存: ${runDir}/`);
}

main().catch(e => {
  console.error(`fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
