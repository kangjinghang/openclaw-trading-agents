// src/orchestrator.ts

import OpenAI from "openai";
import { execPython } from "./exec-python";
import { loadAndRender } from "./prompt-loader";
import { callLLM, parseVerdict } from "./llm-client";
import { TraceLogger } from "./trace-logger";
import { ReportStore } from "./report-store";
import {
  TradingAgentsConfig,
  QuickAnalysisResult,
  AnalystReport,
  FinalDecision,
  ScriptResult,
} from "./types";
import * as path from "path";
import * as os from "os";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

/**
 * Parse a direction string into a valid FinalDecision direction.
 * Supports Chinese and English direction names.
 */
function parseDirection(raw?: string): FinalDecision["direction"] {
  if (!raw) return "Hold";

  const normalized = raw.toLowerCase().trim();

  // English mappings
  if (normalized === "buy" || normalized === "overweight") return "Buy";
  if (normalized === "hold" || normalized === "neutral") return "Hold";
  if (normalized === "sell" || normalized === "underweight") return "Sell";

  // Chinese mappings
  if (normalized === "买入" || normalized === "增持") return "Buy";
  if (normalized === "持有" || normalized === "中性") return "Hold";
  if (normalized === "卖出" || normalized === "减持") return "Sell";

  // Default to Hold for unrecognized directions
  return "Hold";
}

/** Analyst configuration: maps role → data script + prompt template + system prompt */
const ANALYST_CONFIGS = [
  {
    role: "market",
    script: "trading-kline/scripts/kline.py",
    prompt: "analysts/market.md",
    systemPrompt: "You are a professional market analyst specializing in Chinese A-share markets.",
    dataKey: "kline",
    extraArgs: (_ticker: string) => ["--count", "60"],
  },
  {
    role: "fundamentals",
    script: "trading-fundamentals/scripts/fundamentals.py",
    prompt: "analysts/fundamentals.md",
    systemPrompt: "You are a fundamentals analyst specializing in Chinese A-share markets, following CAS accounting standards.",
    dataKey: "fundamentals",
    extraArgs: () => [],
  },
  {
    role: "news",
    script: "trading-news/scripts/news.py",
    prompt: "analysts/news.md",
    systemPrompt: "You are a news analyst specializing in Chinese A-share markets.",
    dataKey: "news",
    extraArgs: () => ["--lookback-days", "7"],
  },
  {
    role: "sentiment",
    script: "trading-sentiment/scripts/sentiment.py",
    prompt: "analysts/sentiment.md",
    systemPrompt: "You are a market sentiment analyst specializing in Chinese A-share markets.",
    dataKey: "sentiment",
    extraArgs: () => [],
  },
  {
    role: "policy",
    script: "trading-news/scripts/news.py",
    prompt: "analysts/policy.md",
    systemPrompt: "You are a policy analyst specializing in Chinese A-share markets.",
    dataKey: "news",
    extraArgs: () => ["--lookback-days", "14"],
  },
  {
    role: "hot_money",
    script: "trading-hot-money/scripts/hot_money.py",
    prompt: "analysts/hot_money.md",
    systemPrompt: "You are a hot money tracker specializing in Chinese A-share markets.",
    dataKey: "hot_money",
    extraArgs: () => [],
  },
  {
    role: "lockup",
    script: "trading-lockup/scripts/lockup.py",
    prompt: "analysts/lockup.md",
    systemPrompt: "You are a lockup watcher specializing in Chinese A-share markets.",
    dataKey: "lockup",
    extraArgs: () => [],
  },
] as const;

/**
 * Run a quick analysis workflow with 7 parallel analysts:
 * 1. Fetch data from all 7 scripts in parallel (graceful degradation)
 * 2. Run all 7 analysts in parallel (graceful degradation)
 * 3. Portfolio Manager synthesizes all 7 reports
 * 4. Persist and return result
 */
export async function runQuickAnalysis(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI
): Promise<QuickAnalysisResult> {
  const startTime = Date.now();

  const traceDir = path.join(os.homedir(), ".openclaw", "traces", `${ticker}_${date}`);
  const traceLogger = new TraceLogger(traceDir);
  const reportStore = new ReportStore(config.report_dir);

  let totalTokens = 0;
  let totalCostUsd = 0;

  // ── Phase 1: Fetch data from all 7 scripts in parallel ──────────
  const dataResults = await Promise.all(
    ANALYST_CONFIGS.map(async (cfg) => {
      const scriptPath = path.join(SKILLS_DIR, cfg.script);
      const args = ["--ticker", ticker, "--date", date, ...cfg.extraArgs(ticker)];
      try {
        const result: ScriptResult = await execPython(scriptPath, args);
        return { role: cfg.role, result };
      } catch (err: any) {
        return { role: cfg.role, result: { success: false, error: err.message } as ScriptResult };
      }
    })
  );

  // Build data map: role → JSON string
  const dataMap: Record<string, string> = {};
  for (const { role, result } of dataResults) {
    if (result.success && result.data) {
      dataMap[role] = JSON.stringify(result.data, null, 2);
    } else {
      dataMap[role] = `[数据缺失: ${result.error || "unknown error"}]`;
    }
  }

  // ── Phase 2: Run all 7 analysts in parallel ─────────────────────
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const analystPromises = ANALYST_CONFIGS.map(async (cfg) => {
    try {
      const dataJson = dataMap[cfg.role];
      const userMessage = loadAndRender(
        cfg.prompt,
        { ticker, date, [cfg.dataKey]: dataJson },
        promptsBaseDir
      );

      const llmResult = await callLLM(openaiClient, {
        model: config.models.analyst,
        systemPrompt: cfg.systemPrompt,
        userMessage,
        temperature: 0.4,
        maxTokens: 4000,
        phase: "analyst",
        role: cfg.role,
        traceLogger,
      });

      totalTokens += llmResult.usage.total_tokens;
      totalCostUsd += llmResult.costUsd;

      const verdict = parseVerdict(llmResult.content);

      return {
        role: cfg.role,
        content: llmResult.content,
        verdict: verdict || { direction: "中性", reason: "无法解析结论" },
        data_sources_used: [cfg.dataKey],
      } as AnalystReport;
    } catch (err: any) {
      return {
        role: cfg.role,
        content: `[分析失败: ${err.message}]`,
        verdict: { direction: "中性", reason: "分析失败" },
        data_sources_used: [],
      } as AnalystReport;
    }
  });

  const analystReports: AnalystReport[] = await Promise.all(analystPromises);

  // ── Phase 3: Portfolio Manager ───────────────────────────────────
  const allReportsText = analystReports
    .map(
      (r) =>
        `## ${r.role} 分析师报告\n\n${r.content}\n\nVERDICT: ${r.verdict.direction} — ${r.verdict.reason}`
    )
    .join("\n\n---\n\n");

  const portfolioPrompt = loadAndRender(
    "portfolio_manager.md",
    { ticker, date, analyst_reports: allReportsText },
    promptsBaseDir
  );

  const portfolioResult = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt:
      "You are a portfolio manager making final trading decisions based on analyst reports.",
    userMessage: portfolioPrompt,
    temperature: 0.3,
    maxTokens: 4000,
    phase: "portfolio",
    role: "portfolio_manager",
    traceLogger,
  });

  totalTokens += portfolioResult.usage.total_tokens;
  totalCostUsd += portfolioResult.costUsd;

  const portfolioVerdict = parseVerdict(portfolioResult.content);
  if (!portfolioVerdict) {
    throw new Error("Failed to parse portfolio manager verdict from LLM response");
  }

  // ── Assemble result ──────────────────────────────────────────────
  const analystVerdicts: Record<string, string> = {};
  for (const report of analystReports) {
    analystVerdicts[report.role] = report.verdict.direction;
  }

  const finalDecision: FinalDecision = {
    ticker,
    company_name: ticker,
    date,
    direction: parseDirection(portfolioVerdict.direction),
    confidence: 0.7,
    target_price: 0,
    stop_loss: 0,
    position_pct: 0,
    reasoning: portfolioVerdict.reason,
    key_risks: [],
    analyst_verdicts: analystVerdicts,
    bull_bear_summary: "",
    risk_assessment: "pass",
    execution_plan: "",
    next_review_trigger: "",
  };

  const result: QuickAnalysisResult = {
    ticker,
    date,
    mode: "quick",
    analysts: analystReports,
    final: finalDecision,
  };

  const durationMs = Date.now() - startTime;
  reportStore.save(ticker, date, "quick", result, durationMs, totalTokens, totalCostUsd);

  return result;
}
