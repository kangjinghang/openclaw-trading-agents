"use strict";
// src/rank-cli.ts
//
// LLM 精排命令行入口。
// 读最新 candidates.json → LLM 排名（LONG/SHORT 两组）→ 写 scan-*.json + scan.json。
//
// Usage:
//   npm run rank
//   npm run rank -- --date 2026-06-17 --top 15 --long-top 7 --short-top 8
//   npm run rank -- --model glm-5-turbo --api-key xxx --base-url https://...
// 可用模型: glm-5.2, glm-5.1, glm-5-turbo, glm-5, glm-4.7, glm-4.7-flash, glm-4.7-flashx, glm-4.6, glm-4.5-air, glm-4.5-airx, glm-4.5-flash
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
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const openai_1 = __importDefault(require("openai"));
const llm_client_1 = require("./llm-client");
const trace_logger_1 = require("./trace-logger");
const ranker_1 = require("./watchlist/ranker");
const atomic_json_1 = require("./watchlist/atomic-json");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
const DEFAULT_MODEL = "glm-5-turbo";
const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
function readJson(fp) {
    if (!fs.existsSync(fp))
        return null;
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
}
/** derived/ 目录里日期最大的 candidates.json（= 最新 data_date）。 */
function findLatestCandidates(dir) {
    const derivedDir = path.join(dir, "derived");
    if (!fs.existsSync(derivedDir))
        return null;
    const dates = fs
        .readdirSync(derivedDir)
        .filter((f) => /^(\d{4}-\d{2}-\d{2})-candidates\.json$/.test(f))
        .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-candidates\.json$/)[1])
        .sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
}
/** 从 ~/.openclaw/openclaw.json 读 plugin config（可选；缺则用 env / 默认）。 */
function loadPluginConfig() {
    const openclawJson = path.join(os.homedir(), ".openclaw", "openclaw.json");
    if (!fs.existsSync(openclawJson))
        return {};
    try {
        const root = JSON.parse(fs.readFileSync(openclawJson, "utf-8"));
        const cfg = root?.plugins?.entries?.["trading-agents"]?.config;
        if (!cfg)
            return {};
        return {
            api_key: cfg.api_key,
            base_url: cfg.base_url,
            // ranker 用 analyst 层模型（可在 config.models.ranker 覆盖，未配置则用 analyst）
            model: cfg.models?.ranker ?? cfg.models?.analyst,
        };
    }
    catch {
        return {};
    }
}
function argValue(args, key) {
    const idx = args.indexOf(key);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
async function main() {
    const args = process.argv.slice(2);
    const help = args.includes("--help") || args.includes("-h");
    const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;
    if (help) {
        console.log(`Usage: npm run rank [-- --date <D> --top <N> --long-top <N> --short-top <N> \\
                  --model <M> --api-key <K> --base-url <U>]

LLM 精排：读 candidates.json → LONG/SHORT 分别 LLM 排名 → 写 scan-*.json + scan.json

Options:
  --date <D>         扫描日（默认最新 candidates）
  --top <N>          总精选数（默认 15，仅参考；实际以 long-top+short-top 为准）
  --long-top <N>     LONG 组精选（默认 7）
  --short-top <N>    SHORT 组精选（默认 8）
  --model <M>        模型名（默认 ${DEFAULT_MODEL}，或读 openclaw.json 的 config.models.ranker/analyst）
  --api-key <K>      OpenAI 兼容 API key（默认读 openclaw.json 或 OPENAI_API_KEY）
  --base-url <U>     OpenAI 兼容 base URL（默认读 openclaw.json 或 OPENAI_BASE_URL）
  --help             显示本帮助
  WATCHLIST_DIR      存储路径（默认 ${DEFAULT_WATCHLIST_DIR}）
`);
        process.exit(0);
    }
    const dateArg = argValue(args, "--date");
    const date = dateArg ?? findLatestCandidates(watchlistDir);
    const topLong = parseInt(argValue(args, "--long-top") ?? "7", 10);
    const topShort = parseInt(argValue(args, "--short-top") ?? "8", 10);
    if (!date) {
        console.error(`error: 没有任何 candidates，请先运行 npm run candidates`);
        process.exit(1);
    }
    const candidatesPath = path.join(watchlistDir, "derived", `${date}-candidates.json`);
    const candidates = readJson(candidatesPath);
    if (!candidates) {
        console.error(`error: candidates 不存在: ${candidatesPath}`);
        console.error(`请先运行 npm run candidates -- --date ${date}`);
        process.exit(1);
    }
    // 配置优先级：CLI args > openclaw.json > env > 默认
    const pluginCfg = loadPluginConfig();
    const apiKey = argValue(args, "--api-key") ?? pluginCfg.api_key ?? process.env.OPENAI_API_KEY;
    const baseUrl = argValue(args, "--base-url") ?? pluginCfg.base_url ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
    const model = argValue(args, "--model") ?? pluginCfg.model ?? DEFAULT_MODEL;
    if (!apiKey) {
        console.error(`error: 缺 API key。请通过 --api-key、openclaw.json 或 OPENAI_API_KEY 提供`);
        process.exit(2);
    }
    const clientOpts = { apiKey };
    if (baseUrl)
        clientOpts.baseURL = baseUrl;
    const client = new openai_1.default(clientOpts);
    // Trace 写到 scan/{date}/traces/，独立于单股 trace
    const scanDir = path.join(watchlistDir, "scan", date);
    const traceDir = path.join(scanDir, "traces");
    // 同 scan_date 内只保留本次的 trace：清空旧文件（同输入多次跑 LLM 响应略不同，
    // 老 trace 无审计价值；复盘只需要当天最后一次决策的上下文）
    if (fs.existsSync(traceDir)) {
        let cleaned = 0;
        for (const f of fs.readdirSync(traceDir)) {
            if (f.endsWith(".json")) {
                fs.unlinkSync(path.join(traceDir, f));
                cleaned++;
            }
        }
        if (cleaned > 0)
            console.log(`  清理旧 trace: ${cleaned} 个`);
    }
    const traceLogger = new trace_logger_1.TraceLogger(traceDir, `rank-${date}`);
    // 构造 RankLlmCaller：包装 callLLM，phase="rank"、role=group
    const caller = async ({ group, systemPrompt, userMessage }) => {
        const result = await (0, llm_client_1.callLLM)(client, {
            model,
            systemPrompt,
            userMessage,
            phase: "rank",
            role: `${group.toLowerCase()}-ranker`,
            traceLogger,
            temperature: 0.3,
        });
        return result.content;
    };
    console.log(`\nranker 开始: ${date}`);
    console.log(`  模型: ${model}${baseUrl ? ` @ ${baseUrl}` : ""}`);
    console.log(`  候选总数: ${candidates.up.length}（LONG ${candidates.up.filter(c => c.range.type === "LONG").length}, SHORT ${candidates.up.filter(c => c.range.type === "SHORT").length}）`);
    console.log(`  目标: LONG top-${topLong} + SHORT top-${topShort}`);
    const result = await (0, ranker_1.rankCandidates)(candidates, { topLong, topShort, caller });
    // 写盘
    (0, atomic_json_1.writeAtomicJson)(path.join(scanDir, "scan-long.json"), result.longResult);
    (0, atomic_json_1.writeAtomicJson)(path.join(scanDir, "scan-short.json"), result.shortResult);
    (0, atomic_json_1.writeAtomicJson)(path.join(scanDir, "scan.json"), result.summary);
    // run_summary.json（独立账目，与单股 run_summary 分账；只记 tokens，不记 cost）
    const runSummary = {
        scan_date: date,
        model,
        tokens: traceLogger.totalTokens,
        groups: result.summary.groups,
        written_at: new Date().toISOString(),
    };
    (0, atomic_json_1.writeAtomicJson)(path.join(watchlistDir, "run_summary.json"), runSummary);
    // 打印结果
    const groups = result.summary.groups;
    console.log(`\n=== 排名结果 ===`);
    console.log(`LONG: ${groups.LONG.total} 支 → top-${groups.LONG.ranked}${groups.LONG.fallback ? " [规则降级]" : ""}`);
    console.log(`SHORT: ${groups.SHORT.pre_filter} → 共同过滤 ${groups.SHORT.post_common_filter} → SHORT 过滤 ${groups.SHORT.total} → top-${groups.SHORT.ranked}${groups.SHORT.fallback ? " [规则降级]" : ""}`);
    console.log(`\ntop picks (跨组按 score 降序):`);
    for (const p of result.summary.top_picks) {
        const pct = p.percent > 0 ? `+${p.percent}` : `${p.percent}`;
        console.log(`  ${p.score.toFixed(1)} [${p.group}] ${p.ticker} ${p.name} | ${pct}% / ${p.days}d / ${p.range_kind}`);
        console.log(`        ${p.reason}`);
    }
    console.log(`\n输出:`);
    console.log(`  ${path.join(scanDir, "scan-long.json")}`);
    console.log(`  ${path.join(scanDir, "scan-short.json")}`);
    console.log(`  ${path.join(scanDir, "scan.json")}`);
    console.log(`  ${path.join(watchlistDir, "run_summary.json")}`);
    console.log(`  tokens: ${traceLogger.totalTokens}`);
}
if (require.main === module)
    main().catch((e) => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
//# sourceMappingURL=rank-cli.js.map