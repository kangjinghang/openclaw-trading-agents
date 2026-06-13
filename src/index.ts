import OpenAI from "openai";
import { Type } from "@sinclair/typebox";
import { runQuickAnalysis, runFullAnalysis } from "./orchestrator";
import { TradingAgentsConfig, QuickAnalysisResult, FullAnalysisResult } from "./types";
import * as path from "path";
import * as os from "os";

const DEFAULT_CONFIG: TradingAgentsConfig = {
  models: { analyst: "glm-4.7-flash", debater: "glm-4.7", decision: "glm-4.7", risk: "glm-4.7" },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  report_dir: "~/.openclaw/trading-reports",
  llm_concurrency: 1,
};

function resolveConfig(userConfig?: Partial<TradingAgentsConfig>): TradingAgentsConfig {
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
async function buildClient(api: any, config: TradingAgentsConfig): Promise<OpenAI> {
  // 1. Plugin-level overrides (highest priority)
  if (config.api_key) {
    const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: config.api_key };
    if (config.base_url) opts.baseURL = config.base_url;
    return new OpenAI(opts);
  }

  // 2. OpenClaw host provider resolution
  const cfg = api.config;
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

  // 3. Env vars fallback (OPENAI_API_KEY / OPENAI_BASE_URL)
  const constructorOpts: ConstructorParameters<typeof OpenAI>[0] = {};
  if (apiKey) constructorOpts.apiKey = apiKey;
  if (baseUrl) constructorOpts.baseURL = baseUrl;

  return new OpenAI(constructorOpts);
}

function toolResult(data: unknown, isError = false) {
  if (!isError && isAnalysisResult(data)) {
    return {
      content: [{ type: "text" as const, text: formatSummary(data) }],
      details: data,
    };
  }
  return {
    content: [{ type: "text" as const, text: isError ? formatError(data) : JSON.stringify(data, null, 2) }],
    details: data,
    isError,
  };
}

function isAnalysisResult(data: unknown): data is QuickAnalysisResult | FullAnalysisResult {
  return typeof data === "object" && data !== null &&
    "ticker" in data && "final" in data && "analysts" in data;
}

function directionEmoji(d: string): string {
  const lower = d.toLowerCase();
  if (["buy", "overweight", "看多"].includes(lower)) return "🟢";
  if (["sell", "underweight", "看空"].includes(lower)) return "🔴";
  return "🟡";
}

function formatSummary(data: QuickAnalysisResult | FullAnalysisResult): string {
  const f = data.final;
  const dir = directionEmoji(f.direction) + " " + f.direction;
  const conf = `${(f.confidence * 100).toFixed(0)}%`;

  // Analyst vote breakdown
  const votes: Record<string, number> = {};
  let failed = 0;
  for (const a of data.analysts) {
    if (a.content.startsWith("[分析失败") || a.content.startsWith("[分析跳过")) {
      failed++;
    } else {
      const v = a.verdict.direction;
      votes[v] = (votes[v] || 0) + 1;
    }
  }
  const total = data.analysts.length;
  const succeeded = total - failed;
  const voteStr = Object.entries(votes).map(([d, c]) => `${c}${d}`).join("/");

  const lines: string[] = [];
  lines.push(`## ${f.company_name || data.ticker} (${data.ticker}) — ${data.date} ${data.mode === "full" ? "Full" : "Quick"} 分析`);
  lines.push("");
  lines.push(`**方向: ${dir}** | 置信度: ${conf} | 分析师: ${succeeded}/${total} 成功${failed > 0 ? ` (${failed}个失败)` : ""}`);
  if (voteStr) lines.push(`投票: ${voteStr}`);
  lines.push("");

  // Core reasoning (first 200 chars)
  if (f.reasoning) {
    lines.push("### 核心理由");
    lines.push(f.reasoning.slice(0, 300));
    lines.push("");
  }

  // Full mode extras
  if (data.mode === "full") {
    const full = data as FullAnalysisResult;
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
      if (ra.retries_exhausted) lines.push("> ⚠ 重试次数已耗尽");
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("完整报告已保存，可使用 `trading_report` 工具查询详情。");
  return lines.join("\n");
}

function formatError(data: unknown): string {
  if (typeof data !== "object" || data === null) return JSON.stringify(data, null, 2);
  const d = data as Record<string, unknown>;
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
const QuickAnalysisParams = Type.Object({
  ticker: Type.String({ description: "A股股票代码，如 600519（贵州茅台）、000001（平安银行）" }),
  date: Type.Optional(Type.String({ description: "分析日期 YYYY-MM-DD，默认今天" })),
});

const FullAnalysisParams = Type.Object({
  ticker: Type.String({ description: "A股股票代码，如 600519（贵州茅台）、000001（平安银行）" }),
  date: Type.Optional(Type.String({ description: "分析日期 YYYY-MM-DD，默认今天" })),
});

const ReportQueryParams = Type.Object({
  ticker: Type.String({ description: "A股股票代码" }),
  date: Type.String({ description: "报告日期 YYYY-MM-DD" }),
  mode: Type.Optional(Type.String({ description: "报告模式: quick 或 full，默认 quick" })),
});

export default {
  id: "trading-agents",
  name: "Trading Agents - A股多角色分析",
  description: "Multi-agent A-share stock analysis with debate-driven decision making",

  register(api: any) {
    const pluginConfig = api.pluginConfig || api?.getConfig?.("trading-agents");
    const config = resolveConfig(pluginConfig);
    const logger = api.logger || console;
    logger.info?.(`[trading-agents] config: models.analyst=${config.models.analyst} llm_concurrency=${config.llm_concurrency} api_key=${config.api_key ? "***set***" : "(from host)"} base_url=${config.base_url || "(from host)"}`);
    // Ensure report directory exists
    const fs = require("fs");
    try { fs.mkdirSync(config.report_dir, { recursive: true }); } catch {}
    let client: OpenAI | undefined;
    async function getClient(): Promise<OpenAI> {
      if (!client) client = await buildClient(api, config);
      return client;
    }

    // Register trading_quick tool
    api.registerTool({
      name: "trading_quick",
      label: "Quick Stock Analysis",
      description: "快速A股分析 — 7位分析师 + 投资组合经理，约8次LLM调用。适用于快速了解一只股票的基本面、技术面、资金面概况。",
      parameters: QuickAnalysisParams,
      async execute(_toolCallId: string, params: { ticker: string; date?: string }, _signal: any, onUpdate: any) {
        const date = params.date || new Date().toISOString().split("T")[0];
        const onProgress = onUpdate ? (text: string, id?: string) => {
          const p: any = { text, visibility: "channel", privacy: "public" as const };
          if (id) p.id = id;
          onUpdate({ content: [], details: undefined, progress: p });
        } : undefined;
        try {
          const [result] = await runQuickAnalysis(params.ticker, date, config, await getClient(), undefined, onProgress);
          return toolResult(result);
        } catch (err: any) {
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
      async execute(_toolCallId: string, params: { ticker: string; date?: string }, _signal: any, onUpdate: any) {
        const date = params.date || new Date().toISOString().split("T")[0];
        const onProgress = onUpdate ? (text: string, id?: string) => {
          const p: any = { text, visibility: "channel", privacy: "public" as const };
          if (id) p.id = id;
          onUpdate({ content: [], details: undefined, progress: p });
        } : undefined;
        try {
          const [result] = await runFullAnalysis(params.ticker, date, config, await getClient(), undefined, onProgress);
          return toolResult(result);
        } catch (err: any) {
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
      async execute(_toolCallId: string, params: { ticker: string; date: string; mode?: string }) {
        const reportDir = config.report_dir;
        const mode = params.mode || "quick";
        const filePath = path.join(reportDir, params.ticker, `${params.date}_${mode}.json`);
        const fs = await import("fs");
        if (!fs.existsSync(filePath)) {
          return toolResult({ error: "Report not found", ticker: params.ticker, date: params.date, mode });
        }
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return toolResult(data);
      },
    });
  },
};
