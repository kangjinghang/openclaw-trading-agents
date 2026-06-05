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

/**
 * Run a quick analysis workflow:
 * 1. Fetch K-line data via execPython
 * 2. Run market analyst (loadAndRender prompt + callLLM)
 * 3. Parse analyst verdict
 * 4. Run portfolio manager (loadAndRender prompt + callLLM)
 * 5. Parse final decision direction
 * 6. Assemble QuickAnalysisResult
 * 7. Persist via reportStore.save()
 * 8. Return result
 */
export async function runQuickAnalysis(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI
): Promise<QuickAnalysisResult> {
  const startTime = Date.now();

  // 1. Setup trace dir and report store
  const traceDir = path.join(os.homedir(), ".openclaw", "traces", `${ticker}_${date}`);
  const traceLogger = new TraceLogger(traceDir);
  const reportStore = new ReportStore(config.report_dir);

  let totalTokens = 0;
  let totalCostUsd = 0;

  // 2. Fetch K-line data via execPython
  const klineScriptPath = path.join(SKILLS_DIR, "trading-kline", "scripts", "kline.py");
  const klineArgs = ["--ticker", ticker, "--count", "60"];
  const klineResult: ScriptResult = await execPython(klineScriptPath, klineArgs);

  if (!klineResult.success || !klineResult.data) {
    throw new Error(`Failed to fetch K-line data: ${klineResult.error}`);
  }

  const klineData = JSON.stringify(klineResult.data, null, 2);

  // 3. Run market analyst
  const analystPrompt = loadAndRender(
    "analysts/market.md",
    {
      ticker,
      date,
      kline: klineData,
    },
    path.join(SKILLS_DIR, "trading-analysis", "prompts")
  );

  const analystResult = await callLLM(openaiClient, {
    model: config.models.analyst,
    systemPrompt: "You are a professional market analyst specializing in Chinese A-share markets.",
    userMessage: analystPrompt,
    temperature: 0.4,
    maxTokens: 4000,
    phase: "analyst",
    role: "market",
    traceLogger,
  });

  totalTokens += analystResult.usage.total_tokens;
  totalCostUsd += analystResult.costUsd;

  // 4. Parse analyst verdict
  const analystVerdict = parseVerdict(analystResult.content);
  if (!analystVerdict) {
    throw new Error("Failed to parse analyst verdict from LLM response");
  }

  const analystReport: AnalystReport = {
    role: "market",
    content: analystResult.content,
    verdict: analystVerdict,
    data_sources_used: ["K-line"],
  };

  // 5. Run portfolio manager
  const portfolioPrompt = loadAndRender(
    "portfolio_manager.md",
    {
      ticker,
      date,
      analyst_reports: analystResult.content,
    },
    path.join(SKILLS_DIR, "trading-analysis", "prompts")
  );

  const portfolioResult = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt: "You are a portfolio manager making final trading decisions based on analyst reports.",
    userMessage: portfolioPrompt,
    temperature: 0.3,
    maxTokens: 4000,
    phase: "portfolio",
    role: "portfolio_manager",
    traceLogger,
  });

  totalTokens += portfolioResult.usage.total_tokens;
  totalCostUsd += portfolioResult.costUsd;

  // 6. Parse final decision
  const portfolioVerdict = parseVerdict(portfolioResult.content);
  if (!portfolioVerdict) {
    throw new Error("Failed to parse portfolio manager verdict from LLM response");
  }

  // 7. Assemble QuickAnalysisResult
  const finalDecision: FinalDecision = {
    ticker,
    company_name: ticker, // Will be filled by LLM response parsing in future
    date,
    direction: parseDirection(portfolioVerdict.direction),
    confidence: 0.7, // Default confidence
    target_price: 0, // Will be extracted from LLM response in future
    stop_loss: 0, // Will be extracted from LLM response in future
    position_pct: 0, // Will be extracted from LLM response in future
    reasoning: portfolioVerdict.reason,
    key_risks: [],
    analyst_verdicts: { [analystReport.role]: analystVerdict.direction },
    bull_bear_summary: "",
    risk_assessment: "pass",
    execution_plan: "",
    next_review_trigger: "",
  };

  const result: QuickAnalysisResult = {
    ticker,
    date,
    mode: "quick",
    analyst: analystReport,
    final: finalDecision,
  };

  // 8. Persist via reportStore.save()
  const durationMs = Date.now() - startTime;
  reportStore.save(ticker, date, "quick", result, durationMs, totalTokens, totalCostUsd);

  // 9. Return result
  return result;
}
