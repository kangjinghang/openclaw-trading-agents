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
const orchestrator_1 = require("./orchestrator");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const DEFAULT_CONFIG = {
    models: { analyst: "glm-4.7-flash", debater: "glm-4.7", decision: "glm-4.7", risk: "glm-4.7" },
    debate_rounds: 2,
    risk_debate_rounds: 1,
    max_risk_retries: 1,
    report_dir: "~/.openclaw/trading-reports",
    llm_concurrency: 3,
};
function resolveConfig(userConfig) {
    return {
        models: { ...DEFAULT_CONFIG.models, ...userConfig?.models },
        debate_rounds: userConfig?.debate_rounds ?? DEFAULT_CONFIG.debate_rounds,
        risk_debate_rounds: userConfig?.risk_debate_rounds ?? DEFAULT_CONFIG.risk_debate_rounds,
        max_risk_retries: userConfig?.max_risk_retries ?? DEFAULT_CONFIG.max_risk_retries,
        report_dir: userConfig?.report_dir ?? DEFAULT_CONFIG.report_dir,
        llm_concurrency: userConfig?.llm_concurrency ?? DEFAULT_CONFIG.llm_concurrency,
    };
}
/**
 * Build an OpenAI client from the host's configured provider.
 * Uses api.runtime.modelAuth to resolve the API key, and api.config
 * to extract the provider's baseUrl.
 */
async function buildClientFromHost(api) {
    const cfg = api.config;
    // Find the first configured provider with a baseUrl (e.g., zai)
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
    // Try to resolve API key via OpenClaw's model auth
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
    // Fallback: env vars (OPENAI_API_KEY / OPENAI_BASE_URL)
    const constructorOpts = {};
    if (apiKey)
        constructorOpts.apiKey = apiKey;
    if (baseUrl)
        constructorOpts.baseURL = baseUrl;
    return new openai_1.default(constructorOpts);
}
exports.default = {
    id: "trading-agents",
    name: "Trading Agents - A股多角色分析",
    description: "Multi-agent A-share stock analysis with debate-driven decision making",
    register(api) {
        const config = resolveConfig(api.pluginConfig || api?.getConfig?.("trading-agents"));
        let client;
        async function getClient() {
            if (!client)
                client = await buildClientFromHost(api);
            return client;
        }
        // Register trading_quick tool
        api.registerTool({
            name: "trading_quick",
            label: "Quick Stock Analysis",
            description: "Run a quick A-share stock analysis using market analyst and portfolio manager roles.",
            parameters: {
                type: "object",
                properties: {
                    ticker: { type: "string", description: "A-share stock code (e.g. 600519)" },
                    date: { type: "string", description: "Analysis date YYYY-MM-DD. Defaults to today." },
                },
                required: ["ticker"],
            },
            async execute(toolCallId, params) {
                const date = params.date || new Date().toISOString().split("T")[0];
                try {
                    const [result] = await (0, orchestrator_1.runQuickAnalysis)(params.ticker, date, config, await getClient());
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                catch (err) {
                    return {
                        content: [{
                                type: "text",
                                text: JSON.stringify({
                                    error: true,
                                    message: err.message,
                                    ticker: params.ticker
                                })
                            }]
                    };
                }
            },
        });
        // Register trading_full tool
        api.registerTool({
            name: "trading_full",
            label: "Full Stock Analysis (with Debate)",
            description: "Run a full A-share stock analysis with multi-round Bull↔Bear debate, research manager, trader execution plan, and risk assessment.",
            parameters: {
                type: "object",
                properties: {
                    ticker: { type: "string", description: "A-share stock code (e.g. 600519)" },
                    date: { type: "string", description: "Analysis date YYYY-MM-DD. Defaults to today." },
                },
                required: ["ticker"],
            },
            async execute(toolCallId, params) {
                const date = params.date || new Date().toISOString().split("T")[0];
                try {
                    const [result] = await (0, orchestrator_1.runFullAnalysis)(params.ticker, date, config, await getClient());
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                catch (err) {
                    return {
                        content: [{
                                type: "text",
                                text: JSON.stringify({
                                    error: true,
                                    message: err.message,
                                    ticker: params.ticker
                                })
                            }]
                    };
                }
            },
        });
        // Register trading_report tool
        api.registerTool({
            name: "trading_report",
            label: "Query Analysis Report",
            description: "Query a saved stock analysis report by ticker and date.",
            parameters: {
                type: "object",
                properties: {
                    ticker: { type: "string" },
                    date: { type: "string", description: "YYYY-MM-DD" },
                    mode: { type: "string", description: "Report mode: quick or full. Defaults to quick." },
                },
                required: ["ticker", "date"],
            },
            async execute(toolCallId, params) {
                const reportDir = config.report_dir.replace("~", os.homedir());
                const mode = params.mode || "quick";
                const filePath = path.join(reportDir, params.ticker, `${params.date}_${mode}.json`);
                const fs = await Promise.resolve().then(() => __importStar(require("fs")));
                if (!fs.existsSync(filePath)) {
                    return { content: [{ type: "text", text: JSON.stringify({ error: "Report not found" }) }] };
                }
                return { content: [{ type: "text", text: fs.readFileSync(filePath, "utf-8") }] };
            },
        });
    },
};
//# sourceMappingURL=index.js.map