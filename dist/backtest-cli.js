"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.archiveDayRebalance = archiveDayRebalance;
exports.renderDayRebalance = renderDayRebalance;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const openai_1 = __importDefault(require("openai"));
const llm_client_1 = require("./llm-client");
const trace_logger_1 = require("./trace-logger");
const exec_python_1 = require("./exec-python");
const atomic_json_1 = require("./watchlist/atomic-json");
const rebalancer_1 = require("./watchlist/rebalancer");
const shallow_analyzer_1 = require("./watchlist/shallow-analyzer");
const data_fetcher_1 = require("./watchlist/data-fetcher");
const backtest_simulator_1 = require("./watchlist/backtest-simulator");
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
// v3: Position/TradeRecord 加 entry_fitness（评分校准）。字段可选，旧 v2 state 仍可加载
//     （缺失 fitness 的 trade 显示 null，不报错）。
const STATE_VERSION = 3;
const DEFAULT_CAPITAL = 200000; // 20 万小账户
const DEFAULT_LOT_SIZE = 100; // A 股主板最小 1 手
function argValue(args, key) {
    const idx = args.indexOf(key);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
function hasFlag(args, key) {
    return args.includes(key);
}
const klineCache = new Map(); // ticker → 日 K（进程内缓存，不跨进程）
/** 拉指定 ticker 的日 K（120 根），缓存结果。 */
async function fetchKline(ticker) {
    const cached = klineCache.get(ticker);
    if (cached)
        return cached;
    try {
        const code = ticker.replace(/^(SH|SZ)/, "");
        const r = await (0, exec_python_1.execSkillScript)("trading-kline", "kline", PROJECT_ROOT, ["--ticker", code, "--count", "120"]);
        if (!r.success || !r.data)
            return [];
        const bars = r.data.data;
        if (!Array.isArray(bars) || bars.length === 0)
            return [];
        const normalized = bars.map(b => ({ date: String(b.date).slice(0, 10), close: Number(b.close) }));
        klineCache.set(ticker, normalized);
        return normalized;
    }
    catch {
        return [];
    }
}
/** 查指定 ticker 在指定日期的收盘价。找不到返回 null。 */
async function lookupPrice(ticker, date) {
    const bars = await fetchKline(ticker);
    // 精确匹配
    const exact = bars.find(b => b.date === date);
    if (exact)
        return exact.close;
    // 找最近的交易日（date 可能是非交易日，取之前最近的）
    const before = bars.filter(b => b.date <= date).sort((a, b) => b.date.localeCompare(a.date));
    if (before.length > 0)
        return before[0].close;
    return null;
}
// ── 格式化输出 ──────────────────────────────────────────────────────────
function fmt(n, suffix = "%") {
    if (n === null || n === undefined)
        return "N/A";
    return `${n >= 0 ? "+" : ""}${n.toFixed(1)}${suffix}`;
}
/** 数组均值，空数组返回 0。 */
function avg(arr) {
    return arr.length === 0 ? 0 : arr.reduce((s, x) => s + x, 0) / arr.length;
}
function renderResults(results) {
    const lines = [];
    // NAV 曲线
    lines.push("\n═══ 每日 NAV ═══");
    for (const snap of results.navHistory) {
        const actionsStr = snap.actions.length > 0 ? ` | ${snap.actions.join(", ")}` : " | (全 HOLD)";
        lines.push(`Day ${snap.date}: NAV ${snap.nav.toFixed(4)} (${fmt(snap.dailyReturnPct)}) `
            + `cash ${(snap.cashPct * 100).toFixed(0)}% 持仓${snap.positionCount}只${actionsStr}`);
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
            lines.push(`  ${win} ${fit} ${t.ticker} ${t.name}: ${t.entryDate}→${t.exitDate} `
                + `(持${t.holdDays}天) ${fmt(t.returnPct)} @${t.entryPrice.toFixed(2)}→${t.exitPrice?.toFixed(2)}`);
        }
    }
    if (openTrades.length > 0) {
        lines.push("未平仓（回测期末仍持有）：");
        for (const t of openTrades) {
            const win = (t.returnPct ?? 0) > 0 ? "✓" : "✗";
            const fit = t.entryFitness != null ? `[fit${t.entryFitness}]` : "[fit?]";
            lines.push(`  ${win} ${fit} ${t.ticker} ${t.name}: ${t.entryDate}→期末 `
                + `(持${t.holdDays}天) ${fmt(t.returnPct)} @${t.entryPrice.toFixed(2)}`);
        }
    }
    // 评分校准：验证"建仓时 fitness"与"实际收益"是否正相关
    // 核心问题：fitness × 0.022 的仓位公式隐含假设"高分股涨得好"，这一段用数据验证它
    const fitTrades = results.trades.filter(t => t.entryFitness != null && t.returnPct != null);
    if (fitTrades.length >= 3) {
        lines.push("\n═══ 评分校准（fitness → 实际收益）═══");
        lines.push("验证 LLM 评分是否有预测力：高分股是否真涨得多？");
        // 分档：高分 ≥7 / 中分 5-6 / 低分 <5
        const buckets = { high: [], mid: [], low: [] };
        for (const t of fitTrades) {
            if (t.entryFitness >= 7)
                buckets.high.push(t);
            else if (t.entryFitness >= 5)
                buckets.mid.push(t);
            else
                buckets.low.push(t);
        }
        lines.push("分档      样本  平均fitness  平均收益  盈利率");
        const render = (label, arr) => {
            if (arr.length === 0) {
                lines.push(`${label.padEnd(8)}  ${0}只`);
                return;
            }
            const avgFit = avg(arr.map(t => t.entryFitness));
            const avgRet = avg(arr.map(t => t.returnPct));
            const winRate = arr.filter(t => (t.returnPct ?? 0) > 0).length / arr.length;
            lines.push(`${label.padEnd(8)}  ${String(arr.length).padStart(2)}只   fit${avgFit.toFixed(1)}      `
                + `${fmt(avgRet).padStart(7)}   ${(winRate * 100).toFixed(0)}%`);
        };
        render("高分(≥7)", buckets.high);
        render("中分(5-6)", buckets.mid);
        render("低分(<5)", buckets.low);
        lines.push("");
        const highAvg = buckets.high.length > 0 ? avg(buckets.high.map(t => t.returnPct)) : null;
        const lowAvg = buckets.low.length > 0 ? avg(buckets.low.map(t => t.returnPct)) : null;
        if (highAvg !== null && lowAvg !== null) {
            const spread = highAvg - lowAvg;
            if (spread > 2)
                lines.push(`✓ 校准良好：高分档收益(${fmt(highAvg)}) > 低分档(${fmt(lowAvg)})，评分有预测力（差 ${fmt(spread)}）`);
            else if (spread < -2)
                lines.push(`⚠ 校准失准：高分档收益(${fmt(highAvg)}) < 低分档(${fmt(lowAvg)})，评分无预测力，需调 prompt`);
            else
                lines.push(`△ 校准模糊：高分(${fmt(highAvg)}) vs 低分(${fmt(lowAvg)}) 差异小，样本不足或评分区分度低`);
        }
        else {
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
function loadState(statePath) {
    if (!fs.existsSync(statePath))
        return null;
    try {
        const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        // v1 state 拒载（份额语义变了：浮点 vs 手数取整）。
        // v2（含 realCapital/lotSize）向后兼容 v3（entry_fitness 字段可选，缺失=旧持仓无评分）。
        const MIN_COMPAT_VERSION = 2;
        if (!raw?.simulator || typeof raw?.version !== "number" || raw.version < MIN_COMPAT_VERSION) {
            console.error(`  [state] 版本不兼容（文件 v${raw?.version ?? "?"}，需 ≥v${MIN_COMPAT_VERSION}），请用 --reset 重开`);
            return null;
        }
        return raw;
    }
    catch {
        return null;
    }
}
function saveState(statePath, state) {
    (0, atomic_json_1.writeAtomicJson)(statePath, state);
}
// ── scan 日期工具 ──────────────────────────────────────────────────────
/** 列出所有有 scan.json 的日期，升序。 */
function listScanDates(watchlistDir) {
    const scanRoot = path.join(watchlistDir, "scan");
    if (!fs.existsSync(scanRoot))
        return [];
    return fs.readdirSync(scanRoot)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(scanRoot, d, "scan.json")))
        .sort();
}
/** 找 lastProcessed 之后的下一个回测日期。lastProcessed=null 时返回首日。 */
function findNextDate(scanDates, lastProcessed) {
    if (scanDates.length === 0)
        return null;
    if (!lastProcessed)
        return scanDates[0];
    const after = scanDates.filter(d => d > lastProcessed);
    return after.length > 0 ? after[0] : null;
}
/** 把一天的完整调仓决策落盘到 backtest/days/<date>/rebalance.json。
 *
 *  这是回测可审计性的关键：LLM 写的 evaluations（每股评估）、每个 action 的 reason、
 *  组合 summary、约束 revise 过程、每股 fitness/risk/thesis（reason 的"依据"）全部归档。
 *  state.json 只管持仓模拟（精简），调仓"为什么"归这里——两者职责分离。
 *
 *  status 非 ok（被约束否决 / 解析失败）也照存，反而更要看：为什么那天没调成仓。
 *  导出供测试覆盖（CLI 入口默认不导出符号，这里显式导出纯函数）。 */
function archiveDayRebalance(backtestDir, date, holdings, result) {
    const dayDir = path.join(backtestDir, "days", date);
    fs.mkdirSync(dayDir, { recursive: true });
    // 每股报告精简：只留决策相关字段（fitness/risk/deal_breaker/thesis/signals），
    // 不存原始 fundamentals/kline（太大，且可重拉）。这是 rebalancer 做决定的"输入依据"。
    const reportsDigest = result.reports.map(r => ({
        ticker: r.ticker,
        name: r.name,
        sector: r.sector,
        fitness_score: r.fitness_score,
        overall_risk: r.overall_risk,
        deal_breaker: r.deal_breaker,
        is_held: r.is_held,
        days_held: r.days_held,
        locked: r.locked,
        thesis: r.thesis,
        key_signals: r.key_signals,
        risk_flags: r.risk_flags,
    }));
    const archive = {
        date,
        written_at: new Date().toISOString(),
        status: result.status,
        portfolio_before: {
            cash_pct: holdings.cash_pct,
            positions: holdings.positions.map(p => ({
                ticker: p.ticker, name: p.name, sector: p.sector,
                weight: p.weight, entry_price: p.entry_price, entry_date: p.entry_date,
            })),
        },
        rebalancer_output: result.rebalancer_output,
        constraint_check: {
            passed: result.constraint_check.passed,
            violations: result.constraint_check.violations,
            revise_count: result.constraint_check.revise_count,
        },
        position_traces: result.position_traces,
        sector_warnings: result.sector_warnings,
        reports: reportsDigest,
    };
    (0, atomic_json_1.writeAtomicJson)(path.join(dayDir, "rebalance.json"), archive);
}
/** 跑一天的完整流程：normalizeWeights → rebalance → applyPlan → recordNav。
 *  返回当日价格缓存（供打印持仓快照复用）+ 动作列表。
 *
 *  backtestDir：每日调仓决策归档根目录（watchlist/backtest）。每天的 rebalancer 输出
 *  原样落盘到 days/<date>/rebalance.json，让回测从"只知结果"变为"可审计"——
 *  不然调仓理由（evaluations / reason / summary）只活在 os.tmpdir 的 LLM trace 里，
 *  重启即清空，根本回溯不了"为什么那天这么调"。 */
async function runSingleDay(simulator, date, scan, topN, shallowCaller, rebalanceCaller, backtestDir) {
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
    const { dataByTicker } = await (0, data_fetcher_1.fetchAllStockData)(metas, 5, { date });
    const result = await (0, rebalancer_1.rebalancePipeline)({
        scan, holdings, lastRebalance, currentDate: date,
        shallowCaller, rebalanceCaller, dataByTicker,
    });
    // 归档当日完整调仓决策（含 reason / evaluations / summary + 每股 fitness 依据）。
    // 非 ok 也存——失败日更要看（为什么没调成仓）。
    archiveDayRebalance(backtestDir, date, holdings, result);
    let actions = [];
    // 检查 rebalance 是否成功（失败则 HOLD 不更新持仓，但记录 NAV）
    if (result.status !== "ok") {
        console.log(`  ⚠️ rebalance ${result.status}，持仓不变`);
    }
    else {
        // 5. 更新持仓（复用价格缓存；BUY 新股会补查价格）
        const reportsByTicker = new Map();
        for (const r of result.reports) {
            reportsByTicker.set(r.ticker, { fitness_score: r.fitness_score, name: r.name, sector: r.sector });
        }
        const { skippedBuys } = await simulator.applyPlan(result, date, reportsByTicker, priceMap);
        actions = result.rebalancer_output.actions;
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
async function printDaySummary(simulator, date, priceMap, actions) {
    // 当日动作
    const tradeActions = actions.filter(a => a.action !== "HOLD");
    if (tradeActions.length > 0) {
        const parts = tradeActions.map(a => {
            const icon = a.action === "SELL" ? "✗" : "✓";
            const w = a.target_weight > 0 ? ` → ${(a.target_weight * 100).toFixed(1)}%` : "";
            return `${icon} ${a.action} ${a.name}${w}`;
        });
        console.log("  " + parts.join("   "));
    }
    else {
        console.log("  （全 HOLD，无调仓）");
    }
    // 当日 NAV
    const results = simulator.getResults();
    const lastSnap = results.navHistory[results.navHistory.length - 1];
    if (!lastSnap)
        return;
    console.log("\n═══ 当日 ═══");
    console.log(`Day ${lastSnap.date}: NAV ${lastSnap.nav.toFixed(4)} (${fmt(lastSnap.dailyReturnPct)})`
        + ` | 现金 ${(lastSnap.cashPct * 100).toFixed(0)}% | 持仓 ${lastSnap.positionCount} 只`);
    // 当前持仓浮动盈亏（不记入 trades，只是当日快照）
    const holdings = await simulator.currentHoldingsSnapshot(date, priceMap);
    if (holdings.length > 0) {
        console.log("\n═══ 当前持仓（浮动盈亏）═══");
        for (const h of holdings) {
            const icon = h.returnPct >= 0 ? "✓" : "✗";
            console.log(`  ${icon} ${h.name}  ${h.entryDate.slice(5)}建仓  权重 ${(h.weight * 100).toFixed(1)}%  ${fmt(h.returnPct)}`);
        }
    }
    // 累计指标
    const s = results.summary;
    console.log(`\n═══ 累计（${results.navHistory.length} 天）═══`);
    console.log(`总收益 ${fmt(s.totalReturnPct)} | 最大回撤 ${fmt(s.maxDrawdownPct)}`
        + ` | 已平仓 ${s.tradeCount} 笔（胜率 ${(s.winRate * 100).toFixed(0)}%）`);
}
// ── 单日调仓决策查看器（--day <DATE>：读 days/<date>/rebalance.json 渲染） ──
/** 调仓动作的终端图标。SELL/REDUCE 用 ✗（退出/减码），BUY/ADD 用 ✓（进场/加码）。 */
function actionIcon(action) {
    return action === "SELL" || action === "REDUCE" ? "✗" : "✓";
}
/** 渲染一天的归档调仓决策到终端。
 *  这是"为什么那天这么调"的人类可读视图：评估表 + 动作理由 + 组合总结 + 约束博弈。
 *  数据源是 archiveDayRebalance 写的 days/<date>/rebalance.json。
 *  导出供测试覆盖渲染契约（用户依赖此输出读调仓计划）。 */
function renderDayRebalance(archive) {
    const lines = [];
    const statusIcon = archive.status === "ok" ? "✅" : "⚠️";
    lines.push(`\n═══ ${archive.date} 调仓决策 ${statusIcon} ${archive.status} ═══`);
    if (archive.written_at) {
        lines.push(`（生成于 ${archive.written_at.replace("T", " ").slice(0, 19)}）`);
    }
    // 调仓前持仓
    const before = archive.portfolio_before;
    if (before) {
        lines.push(`\n调仓前：现金 ${(before.cash_pct * 100).toFixed(0)}% | 持仓 ${(before.positions || []).length} 只`);
        for (const p of (before.positions || [])) {
            lines.push(`  • ${p.name}（${p.ticker}）${p.sector}  权重 ${(p.weight * 100).toFixed(1)}%  ${p.entry_date}建仓@${p.entry_price}`);
        }
    }
    const out = archive.rebalancer_output;
    if (!out) {
        lines.push("\n（无 rebalancer 输出）");
        return lines.join("\n");
    }
    // 每股评估（evaluations）
    const evals = out.evaluations || [];
    if (evals.length > 0) {
        lines.push("\n── 每股评估（候选 + 持仓）──");
        for (const e of evals) {
            const mark = e.judgment === "BUY" ? "✓BUY "
                : e.judgment === "SELL" ? "✗SELL"
                    : e.judgment === "REDUCE" ? "✗REDU"
                        : e.judgment === "ADD" ? "✓ADD "
                            : e.judgment === "HOLD" ? "  HOLD"
                                : "  SKIP";
            lines.push(`  ${mark}  ${e.ticker}  ${e.brief}`);
        }
    }
    // 调仓动作（含理由）
    const acts = (out.actions || []).filter((a) => a.action !== "HOLD");
    lines.push("\n── 调仓动作 ──");
    if (acts.length === 0) {
        lines.push("  （全 HOLD，无调仓）");
    }
    for (const a of acts) {
        const w = a.target_weight > 0
            ? ` → ${(a.target_weight * 100).toFixed(1)}%（${(a.current_weight * 100).toFixed(1)}%→${(a.target_weight * 100).toFixed(1)}%）`
            : "";
        lines.push(`  ${actionIcon(a.action)} ${a.action} ${a.name}（${a.ticker}）${w}`);
        if (a.reason)
            lines.push(`      理由：${a.reason}`);
    }
    // 组合总结
    if (out.summary) {
        lines.push(`\n── 组合总结 ──\n  ${out.summary}`);
    }
    // 约束博弈（revise 次数 + 违规）
    const cc = archive.constraint_check;
    if (cc && (cc.revise_count ?? 0) > 0) {
        lines.push(`\n── 约束博弈（revise ${cc.revise_count} 次）──`);
        for (const v of (cc.violations || [])) {
            lines.push(`  • ${typeof v === "string" ? v : (v.rule ? v.rule + "：" : "") + (v.detail || "")}`);
        }
    }
    return lines.join("\n");
}
// ── 报告生成（--report / --show 用；在 simulator 副本上调 closeOpenPositions，不污染增量状态） ──
/** 生成完整报告：clone simulator → closeOpenPositions → getResults → 写 run-<ts>/。
 *  在副本上操作，原 simulator/state 不受影响（增量可继续）。 */
async function generateReport(simulator, dates, model, topN, watchlistDir) {
    // clone：serialize → fromSerialized，避免 closeOpenPositions 把持仓记成未平仓交易污染状态
    const clone = backtest_simulator_1.PositionSimulator.fromSerialized(simulator.serialize(), lookupPrice);
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
function makeCallers(client, model, traceLogger) {
    const shallowCaller = async ({ role, data, analyst }) => {
        const systemPrompt = role === "analyst" ? "A 股趋势跟随分析师" : "A 股趋势策略风险分析师";
        const userMessage = role === "analyst"
            ? (0, shallow_analyzer_1.formatAnalystPrompt)(data)
            : (0, shallow_analyzer_1.formatRiskPrompt)(data, analyst);
        const result = await (0, llm_client_1.callLLM)(client, {
            model, systemPrompt, userMessage,
            phase: "rebalance", role: `${role}-backtest`, traceLogger, temperature: 0,
            thinking: { type: "disabled" },
            responseFormat: { type: "json_object" },
        });
        return result.content;
    };
    const rebalanceCaller = async ({ userMessage }) => {
        const result = await (0, llm_client_1.callLLM)(client, {
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
  node dist/backtest-cli.js --day 2026-06-23                         # 看某天为什么这么调仓
  node dist/backtest-cli.js --report                                  # 生成完整报告
  node dist/backtest-cli.js --reset                                   # 清空重开

选项:
  --api-key <K>     LLM API key（或 OPENAI_API_KEY env）
  --base-url <U>    base URL（默认 OPENAI_BASE_URL env）
  --model <M>       模型（默认 glm-5-turbo）
  --date <D>        跑指定单日（必须未处理过；重跑历史用 --reset）
  --dates <D1,D2>   慢路径：一次跑多日（批量补数据用）
  --top-n <N>       候选数（默认 15）
  --capital <RMB>   真实本金（默认 200000）。启用后 BUY/ADD/REDUCE 按手数取整，
                    不足 1 手的高价股自动跳过（回测真实反映"买不起"）
  --lot-size <N>    最小手数（默认 100；科创板 200）
  --show            只读 state，显示 NAV 曲线 + 持仓 + 累计，不跑
  --day <D>         查看某天的调仓决策（每股评估 + 动作理由 + 组合总结 + 约束博弈）
                    读 days/<D>/rebalance.json，跑回测当天自动归档
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
        }
        else {
            console.log("无 state.json，无需重置");
        }
        // reset 后继续走默认增量逻辑（从首日开始）
    }
    const apiKey = argValue(args, "--api-key") ?? process.env.OPENAI_API_KEY;
    const baseUrl = argValue(args, "--base-url") ?? process.env.OPENAI_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4";
    const model = argValue(args, "--model") ?? "glm-5-turbo";
    const topN = Math.max(1, parseInt(argValue(args, "--top-n") ?? "15", 10) || 15);
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
    // ── --day <DATE>：查看某天的调仓决策（读 days/<date>/rebalance.json）──
    const dayArg = argValue(args, "--day");
    if (dayArg) {
        const archivePath = path.join(backtestDir, "days", dayArg, "rebalance.json");
        if (!fs.existsSync(archivePath)) {
            console.error(`error: ${dayArg} 无归档决策（${path.relative(watchlistDir, archivePath)} 不存在）`);
            console.error("       归档在跑回测当天自动生成；历史日需重跑（--reset → 逐日跑到目标日）");
            process.exit(1);
        }
        const archive = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
        console.log(renderDayRebalance(archive));
        process.exit(0);
    }
    // ── --show：只读展示 ──
    if (hasFlag(args, "--show")) {
        if (!state) {
            console.log("尚无回测状态。运行 node dist/backtest-cli.js --api-key <KEY> 开始第一天");
            process.exit(0);
        }
        console.log(`回测进度：${state.processedDates.length} 天（${state.processedDates[0]} → ${state.lastProcessedDate}）`);
        console.log(`配置：top-${state.config.topN} | 模型 ${state.config.model} | 本金 ${capital.toLocaleString()} | 手数取整 ${lotSize}股`);
        const sim = backtest_simulator_1.PositionSimulator.fromSerialized(state.simulator, lookupPrice, simOptions);
        // 展示当前持仓浮动盈亏（用最后处理日的价格）
        const lastDate = state.lastProcessedDate;
        const priceMap = await sim.normalizeWeights(lastDate);
        const results = sim.getResults();
        console.log(renderResults(results));
        const holdings = await sim.currentHoldingsSnapshot(lastDate, priceMap);
        if (holdings.length > 0) {
            console.log("\n═══ 当前持仓（浮动盈亏）═══");
            for (const h of holdings) {
                const icon = h.returnPct >= 0 ? "✓" : "✗";
                console.log(`  ${icon} ${h.name}  ${h.entryDate.slice(5)}建仓  权重 ${(h.weight * 100).toFixed(1)}%  ${fmt(h.returnPct)}`);
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
        const sim = backtest_simulator_1.PositionSimulator.fromSerialized(state.simulator, lookupPrice, simOptions);
        await generateReport(sim, state.processedDates, state.config.model, state.config.topN, watchlistDir);
        process.exit(0);
    }
    // 以下路径需要跑 LLM，必须有 api key
    if (!apiKey) {
        console.error("error: 缺 API key（--api-key <KEY> 或 OPENAI_API_KEY env）");
        process.exit(2);
    }
    // LLM client + callers
    const clientOpts = { apiKey };
    if (baseUrl)
        clientOpts.baseURL = baseUrl;
    const client = new openai_1.default(clientOpts);
    const traceLogger = new trace_logger_1.TraceLogger(path.join(os.tmpdir(), "backtest-traces"), "backtest");
    const { shallowCaller, rebalanceCaller } = makeCallers(client, model, traceLogger);
    // ── 确定要跑的日期(s) + 初始 simulator ──
    let datesToRun;
    let simulator;
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
        simulator = new backtest_simulator_1.PositionSimulator(lookupPrice, simOptions); // 全量从现金起步
    }
    else if (dateArg) {
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
            ? backtest_simulator_1.PositionSimulator.fromSerialized(state.simulator, lookupPrice, simOptions)
            : new backtest_simulator_1.PositionSimulator(lookupPrice, simOptions);
        datesToRun = [date];
        console.log(`回测（单日）: ${date}（top-${topN}，模型 ${model}，本金 ${capital.toLocaleString()}）`);
    }
    else {
        // ── 默认增量：跑下一天 ──
        const lastProcessed = state?.lastProcessedDate ?? null;
        const nextDate = findNextDate(scanDates, lastProcessed);
        if (!nextDate) {
            console.log(`已跑到最新（最后处理 ${lastProcessed ?? "（无）"}），scan 目录没有更新的日期`);
            console.log("  可用 --reset 从头重跑，或 --show 查看当前进度");
            process.exit(0);
        }
        simulator = state
            ? backtest_simulator_1.PositionSimulator.fromSerialized(state.simulator, lookupPrice, simOptions)
            : new backtest_simulator_1.PositionSimulator(lookupPrice, simOptions);
        datesToRun = [nextDate];
        console.log(`回测（增量）: ${nextDate}（top-${topN}，模型 ${model}，本金 ${capital.toLocaleString()}）`);
        if (state) {
            console.log(`  续跑：上次处理 ${state.lastProcessedDate}，已累计 ${state.processedDates.length} 天`);
        }
        else {
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
        const scan = JSON.parse(fs.readFileSync(scanPath, "utf-8"));
        const { priceMap, actions } = await runSingleDay(simulator, date, scan, topN, shallowCaller, rebalanceCaller, backtestDir);
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
        }
        else {
            console.log("已到最新 scan 日期。可用 --report 生成完整报告，或 --reset 重开");
        }
    }
    else {
        // 全量慢路径：生成完整报告
        console.log(`\n状态已保存: ${path.relative(watchlistDir, statePath)}`);
        await generateReport(simulator, datesToRun, model, topN, watchlistDir);
    }
}
// 只在作为主入口运行时执行 CLI；被 import（如测试引入纯函数）时不跑 main()。
if (require.main === module) {
    main().catch(e => {
        console.error(`fatal: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
    });
}
//# sourceMappingURL=backtest-cli.js.map