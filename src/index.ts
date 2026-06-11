import OpenAI from "openai";
import { runQuickAnalysis, runFullAnalysis } from "./orchestrator";
import { TradingAgentsConfig } from "./types";
import * as path from "path";
import * as os from "os";

const DEFAULT_CONFIG: TradingAgentsConfig = {
  models: { analyst: "glm-4.7-flash", debater: "glm-4.7", decision: "glm-4.7", risk: "glm-4.7" },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  report_dir: "~/.openclaw/trading-reports",
  llm_concurrency: 3,
};

function resolveConfig(userConfig?: Partial<TradingAgentsConfig>): TradingAgentsConfig {
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
async function buildClientFromHost(api: any): Promise<OpenAI> {
  const cfg = api.config;
  // Find the first configured provider with a baseUrl (e.g., zai)
  const providers = cfg?.models?.providers || {};
  let baseUrl: string | undefined;
  let providerName: string | undefined;
  for (const [name, provider] of Object.entries(providers)) {
    const p = provider as any;
    if (p?.baseUrl) {
      baseUrl = p.baseUrl;
      providerName = name;
      break;
    }
  }

  // Try to resolve API key via OpenClaw's model auth
  let apiKey: string | undefined;
  if (api.runtime?.modelAuth?.resolveApiKeyForProvider && providerName) {
    try {
      const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({
        provider: providerName,
        cfg,
      });
      apiKey = auth?.apiKey;
    } catch {
      // Fall through to env vars
    }
  }

  // Fallback: env vars (OPENAI_API_KEY / OPENAI_BASE_URL)
  const constructorOpts: ConstructorParameters<typeof OpenAI>[0] = {};
  if (apiKey) constructorOpts.apiKey = apiKey;
  if (baseUrl) constructorOpts.baseURL = baseUrl;

  return new OpenAI(constructorOpts);
}

export default {
  id: "trading-agents",
  name: "Trading Agents - A股多角色分析",
  description: "Multi-agent A-share stock analysis with debate-driven decision making",

  register(api: any) {
    const config = resolveConfig(api.pluginConfig || api?.getConfig?.("trading-agents"));
    let client: OpenAI | undefined;
    async function getClient(): Promise<OpenAI> {
      if (!client) client = await buildClientFromHost(api);
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
      async execute(toolCallId: string, params: { ticker: string; date?: string }) {
        const date = params.date || new Date().toISOString().split("T")[0];
        try {
          const [result] = await runQuickAnalysis(params.ticker, date, config, await getClient());
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
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
      async execute(toolCallId: string, params: { ticker: string; date?: string }) {
        const date = params.date || new Date().toISOString().split("T")[0];
        try {
          const [result] = await runFullAnalysis(params.ticker, date, config, await getClient());
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
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
      async execute(toolCallId: string, params: { ticker: string; date: string; mode?: string }) {
        const reportDir = config.report_dir.replace("~", os.homedir());
        const mode = params.mode || "quick";
        const filePath = path.join(reportDir, params.ticker, `${params.date}_${mode}.json`);
        const fs = await import("fs");
        if (!fs.existsSync(filePath)) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Report not found" }) }] };
        }
        return { content: [{ type: "text", text: fs.readFileSync(filePath, "utf-8") }] };
      },
    });
  },
};
