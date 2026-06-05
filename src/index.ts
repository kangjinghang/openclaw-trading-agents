import OpenAI from "openai";
import { runQuickAnalysis } from "./orchestrator";
import { TradingAgentsConfig } from "./types";
import * as path from "path";
import * as os from "os";

const DEFAULT_CONFIG: TradingAgentsConfig = {
  models: { analyst: "gpt-4o", debater: "claude-sonnet-4-6", decision: "claude-sonnet-4-6", risk: "gpt-4o" },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  report_dir: "~/.openclaw/trading-reports",
};

function resolveConfig(userConfig?: Partial<TradingAgentsConfig>): TradingAgentsConfig {
  return {
    models: { ...DEFAULT_CONFIG.models, ...userConfig?.models },
    debate_rounds: userConfig?.debate_rounds ?? DEFAULT_CONFIG.debate_rounds,
    risk_debate_rounds: userConfig?.risk_debate_rounds ?? DEFAULT_CONFIG.risk_debate_rounds,
    max_risk_retries: userConfig?.max_risk_retries ?? DEFAULT_CONFIG.max_risk_retries,
    report_dir: userConfig?.report_dir ?? DEFAULT_CONFIG.report_dir,
  };
}

export default {
  id: "trading-agents",
  name: "Trading Agents - A股多角色分析",
  description: "Multi-agent A-share stock analysis with debate-driven decision making",

  register(api: any) {
    const config = resolveConfig(api?.getConfig?.("trading-agents"));
    const client = new OpenAI();

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
          const result = await runQuickAnalysis(params.ticker, date, config, client);
          return { type: "text", text: JSON.stringify(result, null, 2) };
        } catch (err: any) {
          return {
            type: "text",
            text: JSON.stringify({
              error: true,
              message: err.message,
              ticker: params.ticker
            })
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
        },
        required: ["ticker", "date"],
      },
      async execute(toolCallId: string, params: { ticker: string; date: string }) {
        const reportDir = config.report_dir.replace("~", os.homedir());
        const filePath = path.join(reportDir, params.ticker, `${params.date}_quick.json`);
        const fs = await import("fs");
        if (!fs.existsSync(filePath)) {
          return { type: "text", text: JSON.stringify({ error: "Report not found" }) };
        }
        return { type: "text", text: fs.readFileSync(filePath, "utf-8") };
      },
    });
  },
};
