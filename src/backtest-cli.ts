// src/backtest-cli.ts
//
// 趋势策略回测（增量持仓模拟版）：
// 默认每次只跑「下一个交易日」，状态落盘 state.json，下次接着跑。
// 避免一次性全量回测 20 分钟看不到中间结果——每天几分钟，逐日看回应。
//
// 用法：
//   node dist/backtest-cli.js --api-key <KEY>                          # 默认：跑下一天（增量）
//   node dist/backtest-cli.js --api-key <KEY> --date 2026-06-18        # 跑指定单日
//   node dist/backtest-cli.js --api-key <KEY> --dates 2026-06-17,06-18 # 慢路径：一次跑多日
//   node dist/backtest-cli.js --show                                    # 只看当前进度，不跑
//   node dist/backtest-cli.js --report                                  # 生成完整报告（含未平仓）
//   node dist/backtest-cli.js --reset                                   # 清空 state，从现金重开

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";
import { callLLM } from "./llm-client";
import { TraceLogger } from "./trace-logger";
import { execSkillScript } from "./exec-python";
import { writeAtomicJson } from "./watchlist/atomic-json";
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
import {
  PositionSimulator,
  type BacktestResults,
  type SerializedSimState,
} from "./watchlist/backtest-simulator";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
// v3: Position/TradeRecord 加 entry_fitness（评分校准）。字段可选，旧 v2 state 仍可加载
//     （缺失 fitness 的 trade 显示 null，不报错）。
const STATE_VERSION = 3;
const DEFAULT_CAPITAL = 200000;   // 20 万小账户
const DEFAULT_LOT_SIZE = 100;     // A 股主板最小 1 手

function argValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], key: string): boolean {
  return args.includes(key);
}

// ── K 线取数 + 价格查询（带内存缓存，避免重复拉取） ──────────────────────

interface KlineBar { date: string; close: number; }
const klineCache = new Map<string, KlineBar[]>();  // ticker → 日 K（进程内缓存，不跨进程）

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

/** 数组均值，空数组返回 0。 */
function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((s, x) => s + x, 0) / arr.length;
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
      const fit = t.entryFitness != null ? `[fit${t.entryFitness}]` : "[fit?]";
      lines.push(
        `  ${win} ${fit} ${t.ticker} ${t.name}: ${t.entryDate}→${t.exitDate} `
        + `(持${t.holdDays}天) ${fmt(t.returnPct)} @${t.entryPrice.toFixed(2)}→${t.exitPrice?.toFixed(2)}`,
      );
    }
  }
  if (openTrades.length > 0) {
    lines.push("未平仓（回测期末仍持有）：");
    for (const t of openTrades) {
      const win = (t.returnPct ?? 0) > 0 ? "✓" : "✗";
      const fit = t.entryFitness != null ? `[fit${t.entryFitness}]` : "[fit?]";
      lines.push(
        `  ${win} ${fit} ${t.ticker} ${t.name}: ${t.entryDate}→期末 `
        + `(持${t.holdDays}天) ${fmt(t.returnPct)} @${t.entryPrice.toFixed(2)}`,
      );
    }
  }

  // 评分校准：验证"建仓时 fitness"与"实际收益"是否正相关
  // 核心问题：fitness × 0.022 的仓位公式隐含假设"高分股涨得好"，这一段用数据验证它
  const fitTrades = results.trades.filter(t => t.entryFitness != null && t.returnPct != null);
  if (fitTrades.length >= 3) {
    lines.push("\n═══ 评分校准（fitness → 实际收益）═══");
    lines.push("验证 LLM 评分是否有预测力：高分股是否真涨得多？");
    // 分档：高分 ≥7 / 中分 5-6 / 低分 <5
    const buckets = { high: [] as typeof fitTrades, mid: [] as typeof fitTrades, low: [] as typeof fitTrades };
    for (const t of fitTrades) {
      if (t.entryFitness! >= 7) buckets.high.push(t);
      else if (t.entryFitness! >= 5) buckets.mid.push(t);
      else buckets.low.push(t);
    }
    lines.push("分档      样本  平均fitness  平均收益  盈利率");
    const render = (label: string, arr: typeof fitTrades) => {
      if (arr.length === 0) { lines.push(`${label.padEnd(8)}  ${0}只`); return; }
      const avgFit = avg(arr.map(t => t.entryFitness!));
      const avgRet = avg(arr.map(t => t.returnPct!));
      const winRate = arr.filter(t => (t.returnPct ?? 0) > 0).length / arr.length;
      lines.push(
        `${label.padEnd(8)}  ${String(arr.length).padStart(2)}只   fit${avgFit.toFixed(1)}      `
        + `${fmt(avgRet).padStart(7)}   ${(winRate * 100).toFixed(0)}%`,
      );
    };
    render("高分(≥7)", buckets.high);
    render("中分(5-6)", buckets.mid);
    render("低分(<5)", buckets.low);
    lines.push("");
    const highAvg = buckets.high.length > 0 ? avg(buckets.high.map(t => t.returnPct!)) : null;
    const lowAvg = buckets.low.length > 0 ? avg(buckets.low.map(t => t.returnPct!)) : null;
    if (highAvg !== null && lowAvg !== null) {
      const spread = highAvg - lowAvg;
      if (spread > 2) lines.push(`✓ 校准良好：高分档收益(${fmt(highAvg)}) > 低分档(${fmt(lowAvg)})，评分有预测力（差 ${fmt(spread)}）`);
      else if (spread < -2) lines.push(`⚠ 校准失准：高分档收益(${fmt(highAvg)}) < 低分档(${fmt(lowAvg)})，评分无预测力，需调 prompt`);
      else lines.push(`△ 校准模糊：高分(${fmt(highAvg)}) vs 低分(${fmt(lowAvg)}) 差异小，样本不足或评分区分度低`);
    } else {
      lines.push(`（样本 ${fitTrades.length} 只偏少，需 30+ 笔交易才能可靠校准）`);
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

// ── state.json 持久化 ──────────────────────────────────────────────────

/** 增量回测的磁盘状态：跨进程续跑的衔接文件。 */
interface BacktestStateFile {
  version: number;
  config: { topN: number; model: string; capital: number; lotSize: number };
  lastProcessedDate: string | null;   // 最后成功处理的日期（用于找「下一天」）
  processedDates: string[];           // 所有已处理日期（防重复）
  simulator: SerializedSimState;       // PositionSimulator 全量状态（含 realCapital/lotSize）
}

function loadState(statePath: string): BacktestStateFile | null {
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    // v1 state 拒载（份额语义变了：浮点 vs 手数取整）。
    // v2（含 realCapital/lotSize）向后兼容 v3（entry_fitness 字段可选，缺失=旧持仓无评分）。
    const MIN_COMPAT_VERSION = 2;
    if (!raw?.simulator || typeof raw?.version !== "number" || raw.version < MIN_COMPAT_VERSION) {
      console.error(`  [state] 版本不兼容（文件 v${raw?.version ?? "?"}，需 ≥v${MIN_COMPAT_VERSION}），请用 --reset 重开`);
      return null;
    }
    return raw as BacktestStateFile;
  } catch {
    return null;
  }
}

function saveState(statePath: string, state: BacktestStateFile): void {
  writeAtomicJson(statePath, state);
}

// ── scan 日期工具 ──────────────────────────────────────────────────────

/** 列出所有有 scan.json 的日期，升序。 */
function listScanDates(watchlistDir: string): string[] {
  const scanRoot = path.join(watchlistDir, "scan");
  if (!fs.existsSync(scanRoot)) return [];
  return fs.readdirSync(scanRoot)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(scanRoot, d, "scan.json")))
    .sort();
}

/** 找 lastProcessed 之后的下一个回测日期。lastProcessed=null 时返回首日。 */
function findNextDate(scanDates: string[], lastProcessed: string | null): string | null {
  if (scanDates.length === 0) return null;
  if (!lastProcessed) return scanDates[0];
  const after = scanDates.filter(d => d > lastProcessed);
  return after.length > 0 ? after[0] : null;
}

// ── 单日处理（增量与全量共用） ─────────────────────────────────────────

interface DayRunResult {
  ok: boolean;
  priceMap: Map<string, number>;
  actions: Action[];
}

/** 跑一天的完整流程：normalizeWeights → rebalance → applyPlan → recordNav。
 *  返回当日价格缓存（供打印持仓快照复用）+ 动作列表。 */
async function runSingleDay(
  simulator: PositionSimulator,
  date: string,
  scan: ScanSummary,
  topN: number,
  shallowCaller: ShallowLlmCaller,
  rebalanceCaller: RebalanceLlmCaller,
): Promise<DayRunResult> {
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

  let actions: Action[] = [];
  // 检查 rebalance 是否成功（失败则 HOLD 不更新持仓，但记录 NAV）
  if (result.status !== "ok") {
    console.log(`  ⚠️ rebalance ${result.status}，持仓不变`);
  } else {
    // 5. 更新持仓（复用价格缓存；BUY 新股会补查价格）
    const reportsByTicker = new Map<string, { fitness_score: number; name: string; sector: string }>();
    for (const r of result.reports as StockReport[]) {
      reportsByTicker.set(r.ticker, { fitness_score: r.fitness_score, name: r.name, sector: r.sector });
    }
    const { skippedBuys } = await simulator.applyPlan(result, date, reportsByTicker, priceMap);
    actions = result.rebalancer_output.actions as Action[];
    // 手数取整跳过的高价股：真实反映"买不起 1 手"，提示用户
    if (skippedBuys.length > 0) {
      for (const s of skippedBuys) {
        console.log(`  ⚠️ 跳过 ${s.name}（${s.ticker}）：${s.reason}`);
      }
    }
  }

  // 6. 记录 NAV（prevNav 取 navHistory 最后一条的真实净值，而非重算）
  const prevNav = simulator.getPrevNav();
  await simulator.recordNav(date, actions, prevNav, priceMap);

  return { ok: result.status === "ok", priceMap, actions };
}

// ── 每日终端输出（增量模式核心：跑完立刻看到结果） ─────────────────────

async function printDaySummary(
  simulator: PositionSimulator,
  date: string,
  priceMap: Map<string, number>,
  actions: Action[],
): Promise<void> {
  // 当日动作
  const tradeActions = actions.filter(a => a.action !== "HOLD");
  if (tradeActions.length > 0) {
    const parts = tradeActions.map(a => {
      const icon = a.action === "SELL" ? "✗" : "✓";
      const w = a.target_weight > 0 ? ` → ${(a.target_weight * 100).toFixed(1)}%` : "";
      return `${icon} ${a.action} ${a.name}${w}`;
    });
    console.log("  " + parts.join("   "));
  } else {
    console.log("  （全 HOLD，无调仓）");
  }

  // 当日 NAV
  const results = simulator.getResults();
  const lastSnap = results.navHistory[results.navHistory.length - 1];
  if (!lastSnap) return;
  console.log("\n═══ 当日 ═══");
  console.log(
    `Day ${lastSnap.date}: NAV ${lastSnap.nav.toFixed(4)} (${fmt(lastSnap.dailyReturnPct)})`
    + ` | 现金 ${(lastSnap.cashPct * 100).toFixed(0)}% | 持仓 ${lastSnap.positionCount} 只`,
  );

  // 当前持仓浮动盈亏（不记入 trades，只是当日快照）
  const holdings = await simulator.currentHoldingsSnapshot(date, priceMap);
  if (holdings.length > 0) {
    console.log("\n═══ 当前持仓（浮动盈亏）═══");
    for (const h of holdings) {
      const icon = h.returnPct >= 0 ? "✓" : "✗";
      console.log(
        `  ${icon} ${h.name}  ${h.entryDate.slice(5)}建仓  权重 ${(h.weight * 100).toFixed(1)}%  ${fmt(h.returnPct)}`,
      );
    }
  }

  // 累计指标
  const s = results.summary;
  console.log(`\n═══ 累计（${results.navHistory.length} 天）═══`);
  console.log(
    `总收益 ${fmt(s.totalReturnPct)} | 最大回撤 ${fmt(s.maxDrawdownPct)}`
    + ` | 已平仓 ${s.tradeCount} 笔（胜率 ${(s.winRate * 100).toFixed(0)}%）`,
  );
}

// ── 报告生成（--report / --show 用；在 simulator 副本上调 closeOpenPositions，不污染增量状态） ──

/** 生成完整报告：clone simulator → closeOpenPositions → getResults → 写 run-<ts>/。
 *  在副本上操作，原 simulator/state 不受影响（增量可继续）。 */
async function generateReport(
  simulator: PositionSimulator,
  dates: string[],
  model: string,
  topN: number,
  watchlistDir: string,
): Promise<BacktestResults> {
  // clone：serialize → fromSerialized，避免 closeOpenPositions 把持仓记成未平仓交易污染状态
  const clone = PositionSimulator.fromSerialized(simulator.serialize(), lookupPrice);
  const lastDate = dates[dates.length - 1];
  await clone.closeOpenPositions(lastDate);

  const results = clone.getResults();

  // 持久化报告
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
  return results;
}

// ── LLM caller 工厂 ────────────────────────────────────────────────────

function makeCallers(client: OpenAI, model: string, traceLogger: TraceLogger) {
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
  return { shallowCaller, rebalanceCaller };
}

// ── 主入口 ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;
  const backtestDir = path.join(watchlistDir, "backtest");
  const statePath = path.join(backtestDir, "state.json");

  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`趋势策略回测（增量持仓模拟）：逐日累积持仓，每天一个进程，状态落盘续跑

用法:
  node dist/backtest-cli.js --api-key <KEY>                          # 默认：跑下一天
  node dist/backtest-cli.js --api-key <KEY> --date 2026-06-18        # 跑指定单日
  node dist/backtest-cli.js --api-key <KEY> --dates 2026-06-17,06-18 # 慢路径：一次多日
  node dist/backtest-cli.js --show                                    # 看当前进度
  node dist/backtest-cli.js --report                                  # 生成完整报告
  node dist/backtest-cli.js --reset                                   # 清空重开

选项:
  --api-key <K>     LLM API key（或 OPENAI_API_KEY env）
  --base-url <U>    base URL（默认 OPENAI_BASE_URL env）
  --model <M>       模型（默认 glm-5-turbo）
  --date <D>        跑指定单日（必须未处理过；重跑历史用 --reset）
  --dates <D1,D2>   慢路径：一次跑多日（批量补数据用）
  --top-n <N>       候选数（默认 10）
  --capital <RMB>   真实本金（默认 200000）。启用后 BUY/ADD/REDUCE 按手数取整，
                    不足 1 手的高价股自动跳过（回测真实反映"买不起"）
  --lot-size <N>    最小手数（默认 100；科创板 200）
  --show            只读 state，显示 NAV 曲线 + 持仓 + 累计，不跑
  --report          读 state，生成 run-<ts>/ 完整报告（含未平仓交易）
  --reset           删 state.json，从 100% 现金重开（重跑历史的第一步）
  --help            显示本帮助
  WATCHLIST_DIR     存储路径（默认 ${DEFAULT_WATCHLIST_DIR}）

增量模式说明：
  - 不传 --date/--dates 时，自动找 state.json 里 lastProcessedDate 的下一天
  - 首次运行（无 state）从最早的 scan 日开始，100% 现金起步
  - 每天跑完立即打印当日结果 + 当前持仓浮动盈亏 + 累计指标
  - state.json 原子写，中途断了下次接着跑
  - 要重跑某历史日：--reset → 逐日跑到目标日`);
    process.exit(0);
  }

  // ── --reset：清空状态 ──
  if (hasFlag(args, "--reset")) {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
      console.log(`已清空 ${statePath}，下次运行将从 100% 现金重新开始`);
    } else {
      console.log("无 state.json，无需重置");
    }
    // reset 后继续走默认增量逻辑（从首日开始）
  }

  const apiKey = argValue(args, "--api-key") ?? process.env.OPENAI_API_KEY;
  const baseUrl = argValue(args, "--base-url") ?? process.env.OPENAI_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4";
  const model = argValue(args, "--model") ?? "glm-5-turbo";
  const topN = Math.max(1, parseInt(argValue(args, "--top-n") ?? "10", 10) || 10);
  // 真实本金 + 手数：手数取整让回测真实反映"买不起 1 手"的高价股。
  // 默认 20 万小账户 / A 股主板 1 手=100 股；续跑时优先用 state 里记录的值，CLI 显式传参可覆盖。
  const capitalArg = argValue(args, "--capital");
  const lotSizeArg = argValue(args, "--lot-size");
  const capitalCli = capitalArg ? Math.max(1000, parseFloat(capitalArg) || DEFAULT_CAPITAL) : undefined;
  const lotSizeCli = lotSizeArg ? Math.max(1, parseInt(lotSizeArg, 10) || DEFAULT_LOT_SIZE) : undefined;
  const scanDates = listScanDates(watchlistDir);

  if (scanDates.length === 0) {
    console.error(`error: 没有找到 scan 数据（${path.join(watchlistDir, "scan")} 下无 scan.json）`);
    console.error("       请先跑 npm run rank 生成 scan 数据");
    process.exit(1);
  }

  const state = loadState(statePath);

  // 最终 capital/lotSize：CLI 显式传参 > state 记录 > 默认值。
  // 续跑必须用同一本金口径，否则取整语义不一致。
  const capital = capitalCli ?? state?.config.capital ?? DEFAULT_CAPITAL;
  const lotSize = lotSizeCli ?? state?.config.lotSize ?? DEFAULT_LOT_SIZE;
  const simOptions = { realCapital: capital, lotSize };

  // ── --show：只读展示 ──
  if (hasFlag(args, "--show")) {
    if (!state) {
      console.log("尚无回测状态。运行 node dist/backtest-cli.js --api-key <KEY> 开始第一天");
      process.exit(0);
    }
    console.log(`回测进度：${state.processedDates.length} 天（${state.processedDates[0]} → ${state.lastProcessedDate}）`);
    console.log(`配置：top-${state.config.topN} | 模型 ${state.config.model} | 本金 ${capital.toLocaleString()} | 手数取整 ${lotSize}股`);
    const sim = PositionSimulator.fromSerialized(state.simulator, lookupPrice, simOptions);
    // 展示当前持仓浮动盈亏（用最后处理日的价格）
    const lastDate = state.lastProcessedDate!;
    const priceMap = await sim.normalizeWeights(lastDate);
    const results = sim.getResults();
    console.log(renderResults(results));
    const holdings = await sim.currentHoldingsSnapshot(lastDate, priceMap);
    if (holdings.length > 0) {
      console.log("\n═══ 当前持仓（浮动盈亏）═══");
      for (const h of holdings) {
        const icon = h.returnPct >= 0 ? "✓" : "✗";
        console.log(
          `  ${icon} ${h.name}  ${h.entryDate.slice(5)}建仓  权重 ${(h.weight * 100).toFixed(1)}%  ${fmt(h.returnPct)}`,
        );
      }
    }
    console.log(`\n下一步：${findNextDate(scanDates, state.lastProcessedDate) ?? "已到最新，可用 --reset 重开"}`);
    process.exit(0);
  }

  // ── --report：生成完整报告 ──
  if (hasFlag(args, "--report")) {
    if (!state) {
      console.error("error: 尚无回测状态，无法生成报告。请先跑若干天");
      process.exit(1);
    }
    const sim = PositionSimulator.fromSerialized(state.simulator, lookupPrice, simOptions);
    await generateReport(sim, state.processedDates, state.config.model, state.config.topN, watchlistDir);
    process.exit(0);
  }

  // 以下路径需要跑 LLM，必须有 api key
  if (!apiKey) {
    console.error("error: 缺 API key（--api-key <KEY> 或 OPENAI_API_KEY env）");
    process.exit(2);
  }

  // LLM client + callers
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (baseUrl) clientOpts.baseURL = baseUrl;
  const client = new OpenAI(clientOpts);
  const traceLogger = new TraceLogger(path.join(os.tmpdir(), "backtest-traces"), "backtest");
  const { shallowCaller, rebalanceCaller } = makeCallers(client, model, traceLogger);

  // ── 确定要跑的日期(s) + 初始 simulator ──
  let datesToRun: string[];
  let simulator: PositionSimulator;

  const datesArg = argValue(args, "--dates");
  const dateArg = argValue(args, "--date");

  if (datesArg) {
    // ── 慢路径：--dates D1,D2,...（全量，与增量互斥）──
    if (dateArg) {
      console.error("error: --date 与 --dates 互斥，请只用一个");
      process.exit(2);
    }
    datesToRun = datesArg.split(",").map(d => d.trim()).filter(Boolean).sort();
    console.log(`回测（慢路径全量）: ${datesToRun.join(" → ")}（top-${topN}，模型 ${model}，本金 ${capital.toLocaleString()}）`);
    simulator = new PositionSimulator(lookupPrice, simOptions);  // 全量从现金起步
  } else if (dateArg) {
    // ── 单日：--date D ──
    const date = dateArg.trim();
    if (!scanDates.includes(date)) {
      console.error(`error: ${date} 没有 scan.json，可用日期：${scanDates.join(", ")}`);
      process.exit(1);
    }
    if (state?.processedDates.includes(date)) {
      console.error(`error: ${date} 已处理过（state.processedDates）`);
      console.error("       要重跑历史日期：--reset → 逐日跑到目标日");
      process.exit(1);
    }
    // 单日模式用当前 state 续跑这一天
    simulator = state
      ? PositionSimulator.fromSerialized(state.simulator, lookupPrice, simOptions)
      : new PositionSimulator(lookupPrice, simOptions);
    datesToRun = [date];
    console.log(`回测（单日）: ${date}（top-${topN}，模型 ${model}，本金 ${capital.toLocaleString()}）`);
  } else {
    // ── 默认增量：跑下一天 ──
    const lastProcessed = state?.lastProcessedDate ?? null;
    const nextDate = findNextDate(scanDates, lastProcessed);
    if (!nextDate) {
      console.log(`已跑到最新（最后处理 ${lastProcessed ?? "（无）"}），scan 目录没有更新的日期`);
      console.log("  可用 --reset 从头重跑，或 --show 查看当前进度");
      process.exit(0);
    }
    simulator = state
      ? PositionSimulator.fromSerialized(state.simulator, lookupPrice, simOptions)
      : new PositionSimulator(lookupPrice, simOptions);
    datesToRun = [nextDate];
    console.log(`回测（增量）: ${nextDate}（top-${topN}，模型 ${model}，本金 ${capital.toLocaleString()}）`);
    if (state) {
      console.log(`  续跑：上次处理 ${state.lastProcessedDate}，已累计 ${state.processedDates.length} 天`);
    } else {
      console.log("  首次运行：从 100% 现金起步");
    }
  }

  // ── 逐日跑（增量模式 datesToRun 长度为 1；全量模式可能多日）──
  for (const date of datesToRun) {
    const scanPath = path.join(watchlistDir, "scan", date, "scan.json");
    if (!fs.existsSync(scanPath)) {
      console.log(`跳过 ${date}: scan.json 不存在`);
      continue;
    }
    const scan = JSON.parse(fs.readFileSync(scanPath, "utf-8")) as ScanSummary;
    const { priceMap, actions } = await runSingleDay(
      simulator, date, scan, topN, shallowCaller, rebalanceCaller,
    );
    await printDaySummary(simulator, date, priceMap, actions);
  }

  // ── 持久化 state.json（增量衔接的核心）──
  const processedDates = Array.from(new Set([
    ...(state?.processedDates ?? []),
    ...datesToRun,
  ])).sort();
  const lastProcessedDate = processedDates[processedDates.length - 1];

  saveState(statePath, {
    version: STATE_VERSION,
    config: { topN, model, capital, lotSize },
    lastProcessedDate,
    processedDates,
    simulator: simulator.serialize(),
  });

  // ── 提示下一步 ──
  const nextDate = findNextDate(scanDates, lastProcessedDate);
  if (datesToRun.length === 1) {
    // 增量/单日模式：提示下一天
    console.log(`\n状态已保存: ${path.relative(watchlistDir, statePath)}`);
    if (nextDate) {
      console.log(`下次运行将处理: ${nextDate}（直接重跑本命令即可）`);
    } else {
      console.log("已到最新 scan 日期。可用 --report 生成完整报告，或 --reset 重开");
    }
  } else {
    // 全量慢路径：生成完整报告
    console.log(`\n状态已保存: ${path.relative(watchlistDir, statePath)}`);
    await generateReport(simulator, datesToRun, model, topN, watchlistDir);
  }
}

main().catch(e => {
  console.error(`fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
