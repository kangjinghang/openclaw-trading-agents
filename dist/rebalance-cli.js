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
/** TODO (Task 16): 真实数据 fetch — 调用 kline.py/news.py/hot_money.py/fundamentals.py
 *  当前 stub：返回空 map，shallow-analyzer 将跳过所有股。 */
async function fetchDataForStocks(_tickers) {
    console.warn(`[warn] 数据 fetch 未实现（Task 16），${_tickers.length} 只股将跳过 shallow-analyzer`);
    return new Map();
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
            phase: "rebalance", role: `${role}-shallow`, traceLogger, temperature: 0.3,
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
    // 拉 data（TODO Task 16: 真实实现，目前 stub）
    const topN = parseInt(argValue(args, "--top-n") ?? "10", 10);
    const allTickers = new Set([
        ...scan.top_picks.slice(0, topN).map(p => p.ticker),
        ...holdings.positions.map(p => p.ticker),
    ]);
    const dataByTicker = await fetchDataForStocks(Array.from(allTickers));
    // 跑 pipeline
    const result = await (0, rebalancer_1.rebalancePipeline)({
        scan, holdings, lastRebalance, currentDate: date,
        shallowCaller, rebalanceCaller, dataByTicker,
        config: { top_n: topN },
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
    };
    (0, atomic_json_1.writeAtomicJson)(path.join(rebalanceDir, "plan.json"), planFile);
    (0, atomic_json_1.writeAtomicJson)(path.join(rebalanceDir, "holdings_snapshot.json"), holdings);
    // 更新 last_rebalance.json
    if (result.rebalancer_output.actions.length > 0) {
        const newLast = {
            date,
            actions: result.rebalancer_output.actions
                .filter(a => a.action !== "HOLD")
                .map(a => ({ action: a.action, ticker: a.ticker, weight: a.target_weight })),
        };
        (0, atomic_json_1.writeAtomicJson)(path.join(watchlistDir, "last_rebalance.json"), newLast);
    }
    // 摘要
    console.log(`\n=== 调仓结果 ===`);
    console.log(`  status: ${result.status}`);
    console.log(`  reports: ${result.reports.length} / 约束: ${result.constraint_check.passed ? "通过" : "违反"} (revise ${result.constraint_check.revise_count})`);
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
}
if (require.main === module)
    main().catch(e => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
//# sourceMappingURL=rebalance-cli.js.map