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
const openai_1 = __importDefault(require("openai"));
const typebox_1 = require("@sinclair/typebox");
const orchestrator_1 = require("./orchestrator");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const DEFAULT_CONFIG = {
    models: { analyst: "glm-4.7-flash", debater: "glm-4.7", decision: "glm-4.7", risk: "glm-4.7" },
    debate_rounds: 2,
    risk_debate_rounds: 1,
    max_risk_retries: 1,
    report_dir: "~/.openclaw/trading-reports",
    llm_concurrency: 1,
};
function resolveConfig(userConfig) {
    const reportDir = userConfig?.report_dir ?? DEFAULT_CONFIG.report_dir;
    return {
        models: { ...DEFAULT_CONFIG.models, ...userConfig?.models },
        debate_rounds: userConfig?.debate_rounds ?? DEFAULT_CONFIG.debate_rounds,
        risk_debate_rounds: userConfig?.risk_debate_rounds ?? DEFAULT_CONFIG.risk_debate_rounds,
        max_risk_retries: userConfig?.max_risk_retries ?? DEFAULT_CONFIG.max_risk_retries,
        report_dir: reportDir.replace("~", os.homedir()),
        llm_concurrency: userConfig?.llm_concurrency ?? DEFAULT_CONFIG.llm_concurrency,
    };
}
/**
 * Build an OpenAI client.
 * Priority: plugin config (api_key/base_url) > OpenClaw host provider > env vars.
 */
async function buildClient(api, config) {
    // 1. Plugin-level overrides (highest priority)
    if (config.api_key) {
        const opts = { apiKey: config.api_key };
        if (config.base_url)
            opts.baseURL = config.base_url;
        return new openai_1.default(opts);
    }
    // 2. OpenClaw host provider resolution
    const cfg = api.config;
    const providers = cfg?.models?.providers || {};
    let baseUrl;
    let providerName;
    for (const [name, provider] of Object.entries(providers)) {
        const p = provider;
        if (p?.baseUrl) {
            baseUrl = p.baseUrl;
            providerName = name;
            break;
        }
    }
    let apiKey;
    if (api.runtime?.modelAuth?.resolveApiKeyForProvider && providerName) {
        try {
            const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({
                provider: providerName,
                cfg,
            });
            apiKey = auth?.apiKey;
        }
        catch {
            // Fall through to env vars
        }
    }
    // 3. Env vars fallback (OPENAI_API_KEY / OPENAI_BASE_URL)
    const constructorOpts = {};
    if (apiKey)
        constructorOpts.apiKey = apiKey;
    if (baseUrl)
        constructorOpts.baseURL = baseUrl;
    return new openai_1.default(constructorOpts);
}
function toolResult(data, isError = false) {
    if (!isError && isAnalysisResult(data)) {
        return {
            content: [{ type: "text", text: formatSummary(data) }],
            details: data,
        };
    }
    return {
        content: [{ type: "text", text: isError ? formatError(data) : JSON.stringify(data, null, 2) }],
        details: data,
        isError,
    };
}
function isAnalysisResult(data) {
    return typeof data === "object" && data !== null &&
        "ticker" in data && "final" in data && "analysts" in data;
}
function directionEmoji(d) {
    const lower = d.toLowerCase();
    if (["buy", "overweight", "看多"].includes(lower))
        return "🟢";
    if (["sell", "underweight", "看空"].includes(lower))
        return "🔴";
    return "🟡";
}
function formatSummary(data) {
    const f = data.final;
    const dir = directionEmoji(f.direction) + " " + f.direction;
    const conf = `${(f.confidence * 100).toFixed(0)}%`;
    // Analyst vote breakdown
    const votes = {};
    let failed = 0;
    for (const a of data.analysts) {
        if (a.content.startsWith("[分析失败") || a.content.startsWith("[分析跳过")) {
            failed++;
        }
        else {
            const v = a.verdict.direction;
            votes[v] = (votes[v] || 0) + 1;
        }
    }
    const total = data.analysts.length;
    const succeeded = total - failed;
    const voteStr = Object.entries(votes).map(([d, c]) => `${c}${d}`).join("/");
    const lines = [];
    lines.push(`## ${f.company_name || data.ticker} (${data.ticker}) — ${data.date} ${data.mode === "full" ? "Full" : "Quick"} 分析`);
    lines.push("");
    lines.push(`**方向: ${dir}** | 置信度: ${conf} | 分析师: ${succeeded}/${total} 成功${failed > 0 ? ` (${failed}个失败)` : ""}`);
    if (voteStr)
        lines.push(`投票: ${voteStr}`);
    lines.push("");
    // Core reasoning (first 200 chars)
    if (f.reasoning) {
        lines.push("### 核心理由");
        lines.push(f.reasoning.slice(0, 300));
        lines.push("");
    }
    // Full mode extras
    if (data.mode === "full") {
        const full = data;
        if (full.trading_plan) {
            lines.push("### 交易计划");
            const tp = full.trading_plan;
            lines.push(`方向: ${tp.direction} | 目标价: ${tp.target_price} | 止损: ${tp.stop_loss} | 仓位: ${tp.position_pct}%`);
            lines.push("");
        }
        if (full.risk_assessment) {
            const ra = full.risk_assessment;
            const statusEmoji = ra.status === "pass" ? "✅" : ra.status === "revise" ? "⚠️" : "🚫";
            lines.push(`### 风控: ${statusEmoji} ${ra.status} (风险评分 ${ra.risk_score}/100)`);
            if (ra.retries_exhausted)
                lines.push("> ⚠ 重试次数已耗尽");
            lines.push("");
        }
    }
    lines.push("---");
    lines.push("完整报告已保存，可使用 `trading_report` 工具查询详情。");
    return lines.join("\n");
}
function formatError(data) {
    if (typeof data !== "object" || data === null)
        return JSON.stringify(data, null, 2);
    const d = data;
    const msg = String(d.message || d.error || "Unknown error");
    const ticker = d.ticker ? ` (${d.ticker})` : "";
    // Detect error type and add suggestions
    if (msg.includes("429") || msg.includes("rate") || msg.includes("限流")) {
        return [
            `## API 限流错误${ticker}`,
            "",
            "请求过于频繁，建议：",
            "1. 降低并发: 配置 `llm_concurrency: 1`",
            "2. 换用更快模型: 配置 `analyst: glm-5-turbo`",
            "3. 稍后重试",
            "",
            `原始错误: ${msg}`,
        ].join("\n");
    }
    if (msg.includes("abort") || msg.includes("timeout") || msg.includes("超时")) {
        return [
            `## 分析超时${ticker}`,
            "",
            "分析耗时过长被中断，建议：",
            "1. 增大超时: 在 openclaw.json 中设置 `diagnostics.stuckSessionAbortMs: 1800000` (30分钟)",
            "2. 使用更快模型: 配置 `analyst: glm-5-turbo`, `analyst_thinking: disabled`",
            "",
            `原始错误: ${msg}`,
        ].join("\n");
    }
    return `## 分析失败${ticker}\n\n${msg}`;
}
// Typebox schemas for tool parameters
const QuickAnalysisParams = typebox_1.Type.Object({
    ticker: typebox_1.Type.String({ description: "A股股票代码，如 600519（贵州茅台）、000001（平安银行）" }),
    date: typebox_1.Type.Optional(typebox_1.Type.String({ description: "分析日期 YYYY-MM-DD，默认今天" })),
});
const FullAnalysisParams = typebox_1.Type.Object({
    ticker: typebox_1.Type.String({ description: "A股股票代码，如 600519（贵州茅台）、000001（平安银行）" }),
    date: typebox_1.Type.Optional(typebox_1.Type.String({ description: "分析日期 YYYY-MM-DD，默认今天" })),
});
const ReportQueryParams = typebox_1.Type.Object({
    ticker: typebox_1.Type.String({ description: "A股股票代码" }),
    date: typebox_1.Type.String({ description: "报告日期 YYYY-MM-DD" }),
    mode: typebox_1.Type.Optional(typebox_1.Type.String({ description: "报告模式: quick 或 full，默认 quick" })),
});
exports.default = {
    id: "trading-agents",
    name: "Trading Agents - A股多角色分析",
    description: "Multi-agent A-share stock analysis with debate-driven decision making",
    register(api) {
        const pluginConfig = api.pluginConfig || api?.getConfig?.("trading-agents");
        const config = resolveConfig(pluginConfig);
        const logger = api.logger || console;
        logger.info?.(`[trading-agents] config: models.analyst=${config.models.analyst} llm_concurrency=${config.llm_concurrency} api_key=${config.api_key ? "***set***" : "(from host)"} base_url=${config.base_url || "(from host)"}`);
        // Ensure report directory exists
        const fs = require("fs");
        try {
            fs.mkdirSync(config.report_dir, { recursive: true });
        }
        catch { }
        let client;
        async function getClient() {
            if (!client)
                client = await buildClient(api, config);
            return client;
        }
        // Register trading_quick tool
        api.registerTool({
            name: "trading_quick",
            label: "Quick Stock Analysis",
            description: "快速A股分析 — 7位分析师 + 投资组合经理，约8次LLM调用。适用于快速了解一只股票的基本面、技术面、资金面概况。",
            parameters: QuickAnalysisParams,
            async execute(_toolCallId, params, _signal, onUpdate) {
                const date = params.date || new Date().toISOString().split("T")[0];
                const onProgress = onUpdate ? (text, id) => {
                    const p = { text, visibility: "channel", privacy: "public" };
                    if (id)
                        p.id = id;
                    onUpdate({ content: [], details: undefined, progress: p });
                } : undefined;
                try {
                    const [result] = await (0, orchestrator_1.runQuickAnalysis)(params.ticker, date, config, await getClient(), undefined, onProgress);
                    return toolResult(result);
                }
                catch (err) {
                    return toolResult({ error: true, message: err.message, ticker: params.ticker }, true);
                }
            },
        });
        // Register trading_full tool
        api.registerTool({
            name: "trading_full",
            label: "Full Stock Analysis (with Debate)",
            description: "全量深度分析 — 7分析师 → 多空辩论 → 研究合成 → 交易计划 → 风控审核，约15+次LLM调用。适用于需要详细交易计划、止损止盈价位、仓位建议。",
            parameters: FullAnalysisParams,
            async execute(_toolCallId, params, _signal, onUpdate) {
                const date = params.date || new Date().toISOString().split("T")[0];
                const onProgress = onUpdate ? (text, id) => {
                    const p = { text, visibility: "channel", privacy: "public" };
                    if (id)
                        p.id = id;
                    onUpdate({ content: [], details: undefined, progress: p });
                } : undefined;
                try {
                    const [result] = await (0, orchestrator_1.runFullAnalysis)(params.ticker, date, config, await getClient(), undefined, onProgress);
                    return toolResult(result);
                }
                catch (err) {
                    return toolResult({ error: true, message: err.message, ticker: params.ticker }, true);
                }
            },
        });
        // Register trading_report tool
        api.registerTool({
            name: "trading_report",
            label: "Query Analysis Report",
            description: "查询已保存的历史分析报告。需要提供股票代码和日期。",
            parameters: ReportQueryParams,
            async execute(_toolCallId, params) {
                const reportDir = config.report_dir;
                const mode = params.mode || "quick";
                const filePath = path.join(reportDir, params.ticker, `${params.date}_${mode}.json`);
                const fs = await Promise.resolve().then(() => __importStar(require("fs")));
                if (!fs.existsSync(filePath)) {
                    return toolResult({ error: "Report not found", ticker: params.ticker, date: params.date, mode });
                }
                const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
                return toolResult(data);
            },
        });
    },
};
//# sourceMappingURL=index.js.map