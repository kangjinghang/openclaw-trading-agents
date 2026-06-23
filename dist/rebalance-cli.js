"use strict";
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
// src/rebalance-cli.ts
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const openai_1 = __importDefault(require("openai"));
const llm_client_1 = require("./llm-client");
const trace_logger_1 = require("./trace-logger");
const holdings_loader_1 = require("./watchlist/holdings-loader");
const rebalancer_1 = require("./watchlist/rebalancer");
const shallow_analyzer_1 = require("./watchlist/shallow-analyzer");
const atomic_json_1 = require("./watchlist/atomic-json");
const data_fetcher_1 = require("./watchlist/data-fetcher");
const plan_formatter_1 = require("./watchlist/plan-formatter");
const data_health_aggregator_1 = require("./watchlist/data-health-aggregator");
const data_trace_report_1 = require("./watchlist/data-trace-report");
const fitness_history_store_1 = require("./watchlist/fitness-history-store");
const fitness_backfiller_1 = require("./watchlist/fitness-backfiller");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
function argValue(args, key) {
    const idx = args.indexOf(key);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
function findLatestScan(watchlistDir) {
    const scanRoot = path.join(watchlistDir, "scan");
    if (!fs.existsSync(scanRoot))
        return null;
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
    const holdings = (0, holdings_loader_1.loadHoldings)(path.join(watchlistDir, "holdings.json"));
    const scanPath = path.join(watchlistDir, "scan", date, "scan.json");
    if (!fs.existsSync(scanPath)) {
        console.error(`error: scan.json 不存在: ${scanPath}`);
        process.exit(1);
    }
    const scan = JSON.parse(fs.readFileSync(scanPath, "utf-8"));
    const lastRebalancePath = path.join(watchlistDir, "last_rebalance.json");
    const lastRebalance = fs.existsSync(lastRebalancePath)
        ? JSON.parse(fs.readFileSync(lastRebalancePath, "utf-8"))
        : null;
    // 懒结算 fitness 历史：回填到期 open 记录的事后收益（≥30 天的算 7/14/30 涨跌幅）。
    // 在数据拉取前跑，本次决策用的是已结算的历史。失败只打日志，绝不阻塞 rebalance。
    try {
        const fitnessStore = new fitness_history_store_1.FitnessHistoryStore(watchlistDir);
        const bf = await (0, fitness_backfiller_1.backfillReturns)(fitnessStore, date);
        if (bf.settled + bf.failed > 0) {
            console.log(`  fitness 历史: 结算 ${bf.settled} 条（失败 ${bf.failed}），跳过未到期 ${bf.skipped} 条`);
        }
    }
    catch (e) {
        console.error(`  [fitness-history] backfill 跳过: ${e instanceof Error ? e.message : e}`);
    }
    // LLM 配置
    const apiKey = argValue(args, "--api-key") ?? process.env.OPENAI_API_KEY;
    const baseUrl = argValue(args, "--base-url") ?? process.env.OPENAI_BASE_URL;
    const model = argValue(args, "--model") ?? "glm-4.7";
    if (!apiKey) {
        console.error(`error: 缺 API key`);
        process.exit(2);
    }
    const clientOpts = { apiKey };
    if (baseUrl)
        clientOpts.baseURL = baseUrl;
    const client = new openai_1.default(clientOpts);
    // Trace
    const rebalanceDir = path.join(watchlistDir, "rebalance", date);
    const traceDir = path.join(rebalanceDir, "traces");
    if (fs.existsSync(traceDir)) {
        for (const f of fs.readdirSync(traceDir)) {
            if (f.endsWith(".json"))
                fs.unlinkSync(path.join(traceDir, f));
        }
    }
    const traceLogger = new trace_logger_1.TraceLogger(traceDir, `rebalance-${date}`);
    // callers
    const shallowCaller = async ({ role, data, analyst }) => {
        const systemPrompt = role === "analyst" ? "A 股综合分析师" : "A 股风险分析师";
        const userMessage = role === "analyst"
            ? (0, shallow_analyzer_1.formatAnalystPrompt)(data)
            : (0, shallow_analyzer_1.formatRiskPrompt)(data, analyst);
        const result = await (0, llm_client_1.callLLM)(client, {
            model, systemPrompt, userMessage,
            phase: "rebalance", role: `${role}-shallow`, traceLogger, temperature: 0,
        });
        return result.content;
    };
    const rebalanceCaller = async ({ userMessage }) => {
        const result = await (0, llm_client_1.callLLM)(client, {
            model, systemPrompt: "A 股投资组合管理者", userMessage,
            phase: "rebalance", role: "portfolio-rebalancer", traceLogger, temperature: 0,
        });
        return result.content;
    };
    console.log(`\nrebalancer 开始: ${date}`);
    console.log(`  模型: ${model}`);
    console.log(`  持仓: ${holdings.positions.length} 支 / cash ${(holdings.cash_pct * 100).toFixed(1)}%`);
    // 拉 data（4 Python scripts 并行）
    const topN = Math.max(1, parseInt(argValue(args, "--top-n") ?? "10", 10) || 10);
    const metasForFetch = [
        ...scan.top_picks.slice(0, topN).map(p => ({
            ticker: p.ticker, name: p.name,
            sector: holdings.positions.find(pos => pos.ticker === p.ticker)?.sector ?? "未分类",
            ranker_thesis: p.reason,
        })),
        ...holdings.positions.map(p => ({ ticker: p.ticker, name: p.name, sector: p.sector })),
    ];
    // 去重
    const seen = new Set();
    const dedupMetas = metasForFetch.filter(m => seen.has(m.ticker) ? false : (seen.add(m.ticker), true));
    console.log(`  拉数据: ${dedupMetas.length} 只股 × 4 scripts（并行 5）`);
    const dataByTicker = await (0, data_fetcher_1.fetchAllStockData)(dedupMetas, 5);
    console.log(`  数据就绪: ${dataByTicker.size}/${dedupMetas.length} 只`);
    // 跑 pipeline
    const result = await (0, rebalancer_1.rebalancePipeline)({
        scan, holdings, lastRebalance, currentDate: date,
        shallowCaller, rebalanceCaller, dataByTicker,
        config: { top_n: topN },
    });
    // 收集数据源健康统计：从 dataByTicker 里提取每个股的 calls，聚合为 run 级别
    const allCalls = [];
    for (const stockData of dataByTicker.values()) {
        if (stockData.calls)
            allCalls.push(...stockData.calls);
    }
    const dataHealth = (0, data_health_aggregator_1.generateDataHealthReport)(date, allCalls, rebalanceDir);
    // 写 data-health.json（子源级调用记录，供历史聚合）
    (0, atomic_json_1.writeAtomicJson)(path.join(rebalanceDir, "data-health.json"), {
        run_date: date,
        calls: allCalls,
    });
    // 写 plan.json
    const planFile = {
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
        position_traces: result.position_traces,
        data_health: dataHealth,
    };
    (0, atomic_json_1.writeAtomicJson)(path.join(rebalanceDir, "plan.json"), planFile);
    (0, atomic_json_1.writeAtomicJson)(path.join(rebalanceDir, "holdings_snapshot.json"), holdings);
    // 采集 fitness 决策快照（为 1-3 个月后的预测力回测铺路）。
    // 每只 report + 对应 action 一条记录，entry_price 取决策日收盘价（kline）。
    // 失败只 stderr，绝不阻塞——这是"锦上添花"，不能让采集失败导致 rebalancer 跑不起来。
    try {
        const fitnessStore = new fitness_history_store_1.FitnessHistoryStore(watchlistDir);
        const actionsByTicker = new Map(result.rebalancer_output.actions.map(a => [a.ticker, a]));
        const records = result.reports.map(r => {
            const action = actionsByTicker.get(r.ticker);
            // fitness_raw：若 quality_notes 含"→6"等钳制标注，说明被改过，溯源记原值
            const clampNote = r.quality_notes?.find(n => /→\s*6/.test(n));
            const clampedMatch = clampNote?.match(/fitness\s+(\d+(?:\.\d+)?)\s*→/);
            return {
                decision_date: date,
                ticker: r.ticker,
                name: r.name,
                action: (action?.action ?? "HOLD"),
                fitness: r.fitness_score,
                ...(clampedMatch ? { fitness_raw: parseFloat(clampedMatch[1]) } : {}),
                overall_risk: r.overall_risk,
                target_weight: action?.target_weight ?? 0,
                // entry_price 此处留 0（不额外拉数据拖慢主流程）。backfiller 结算时从
                // kline 按 decision_date 重拉当日收盘价作为收益基准（和 7/14/30 价同源）。
                entry_price: 0,
                ...(r.quality_notes && r.quality_notes.length > 0 ? { quality_notes: r.quality_notes } : {}),
                run_id: `rebalance-${date}`,
                status: "open",
            };
        });
        fitnessStore.appendDecisions(records);
    }
    catch (e) {
        console.error(`  [fitness-history] 采集跳过: ${e instanceof Error ? e.message : e}`);
    }
    // 写 plan.md（人类可读）
    const planMd = (0, plan_formatter_1.formatPlanMarkdown)(planFile);
    fs.writeFileSync(path.join(rebalanceDir, "plan.md"), planMd, "utf-8");
    // 写 data-trace.md：选第一只股作为代表，展示完整的数据管道调试视图
    if (result.reports.length > 0) {
        const exampleReport = result.reports[0];
        const exampleData = dataByTicker.get(exampleReport.ticker);
        if (exampleData) {
            const traceMd = (0, data_trace_report_1.generateDataTraceReport)(exampleReport.ticker, exampleReport.name, exampleData, exampleReport);
            fs.writeFileSync(path.join(rebalanceDir, "data-trace.md"), traceMd, "utf-8");
        }
    }
    // 更新 last_rebalance.json（含 recent_sells 跨次累积，供 anti-churn 买锁）
    if (result.rebalancer_output.actions.length > 0) {
        // 继承旧的 recent_sells，追加本次 SELL，淘汰 >14 天的旧记录
        const prevSells = lastRebalance?.recent_sells ?? {};
        const mergedSells = { ...prevSells };
        for (const a of result.rebalancer_output.actions) {
            if (a.action === "SELL")
                mergedSells[a.ticker] = date;
        }
        const cutoffMs = new Date(date + "T00:00:00+08:00").getTime() - 14 * 86400000;
        for (const [tick, d] of Object.entries(mergedSells)) {
            if (new Date(d + "T00:00:00+08:00").getTime() < cutoffMs)
                delete mergedSells[tick];
        }
        const newLast = {
            date,
            actions: result.rebalancer_output.actions
                .filter(a => a.action !== "HOLD")
                .map(a => ({ action: a.action, ticker: a.ticker, weight: a.target_weight })),
            recent_sells: mergedSells,
        };
        (0, atomic_json_1.writeAtomicJson)(path.join(watchlistDir, "last_rebalance.json"), newLast);
    }
    // 摘要
    console.log(`\n=== 调仓结果 ===`);
    console.log(`  status: ${result.status}`);
    console.log(`  reports: ${result.reports.length} / 约束: ${result.constraint_check.passed ? "通过" : "违反"} (revise ${result.constraint_check.revise_count})`);
    if (result.sector_warnings.length > 0) {
        console.log(`  ⚠️ 行业警告:`);
        for (const w of result.sector_warnings)
            console.log(`    - ${w}`);
    }
    // 持仓股分析失败兜底提示（fallback report 的 thesis 含 "⚠️ shallow-analyzer 失败"）
    const fallbackReports = result.reports.filter(r => r.thesis.includes("shallow-analyzer 失败"));
    if (fallbackReports.length > 0) {
        console.log(`  ⚠️ ${fallbackReports.length} 只持仓股分析失败，按保守默认处理（fitness=5, risk=high）:`);
        for (const r of fallbackReports)
            console.log(`    - ${r.ticker} ${r.name}: ${r.data_gaps[0] ?? "未知原因"}`);
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
        for (const w of result.execution_plan.warnings)
            console.log(`    - ${w}`);
    }
    console.log(`\n  tokens: ${traceLogger.totalTokens}`);
    console.log(`  输出: ${path.join(rebalanceDir, "plan.json")}`);
    console.log(`  输出: ${path.join(rebalanceDir, "plan.md")}`);
}
if (require.main === module)
    main().catch(e => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
//# sourceMappingURL=rebalance-cli.js.map