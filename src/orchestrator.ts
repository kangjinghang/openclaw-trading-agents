// src/orchestrator.ts

import OpenAI from "openai";
import { execPython } from "./exec-python";
import { loadAndRender } from "./prompt-loader";
import { callLLM, parseVerdict } from "./llm-client";
import { TraceLogger } from "./trace-logger";
import { ReportStore } from "./report-store";
import { runBullBearDebate } from "./debate";
import { runResearchManager } from "./research-manager";
import { runTrader } from "./trader";
import { runRiskDebate, runRiskManager } from "./risk";
import {
  TradingAgentsConfig,
  QuickAnalysisResult,
  FullAnalysisResult,
  AnalystReport,
  FinalDecision,
  ScriptResult,
} from "./types";
import * as path from "path";
import * as os from "os";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

/**
 * Run tasks with limited concurrency and staggered start.
 * Adds a random jitter (0~staggerMs) before each task to avoid burst patterns.
 */
async function pool<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>,
  concurrency: number,
  staggerMs: number = 0
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      if (staggerMs > 0 && i > 0) {
        await new Promise((r) => setTimeout(r, Math.random() * staggerMs));
      }
      await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
}

/**
 * Parse a direction string into a valid FinalDecision direction.
 * Supports Chinese and English direction names.
 */
function parseDirection(raw?: string): FinalDecision["direction"] {
  if (!raw) return "Hold";

  // Take the first option if LLM outputs "看多|看空|中性" style multi-choice
  const firstOption = raw.split("|")[0].trim();
  const normalized = firstOption.toLowerCase();

  // English mappings
  if (normalized === "buy" || normalized === "overweight") return "Buy";
  if (normalized === "hold" || normalized === "neutral") return "Hold";
  if (normalized === "sell" || normalized === "underweight") return "Sell";

  // Chinese mappings
  if (normalized === "买入" || normalized === "增持" || normalized === "看多") return "Buy";
  if (normalized === "持有" || normalized === "中性") return "Hold";
  if (normalized === "卖出" || normalized === "减持" || normalized === "看空") return "Sell";

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
 * Shared Phase 1-2: fetch data + run 7 analysts in parallel.
 * Used by both runQuickAnalysis() and runFullAnalysis().
 */
async function runAnalystPhase(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<{ analystReports: AnalystReport[]; totalTokens: number; totalCostUsd: number }> {
  let totalTokens = 0;
  let totalCostUsd = 0;

  // ── Phase 1: Fetch data from all 7 scripts with concurrency limit ──
  const dataConcurrency = config.llm_concurrency || 3;
  const dataResults: Array<{ role: string; result: ScriptResult }> = new Array(ANALYST_CONFIGS.length);

  await pool(
    ANALYST_CONFIGS,
    async (cfg, idx) => {
      const scriptPath = path.join(SKILLS_DIR, cfg.script);
      const args = ["--ticker", ticker, "--date", date, ...cfg.extraArgs(ticker)];
      try {
        const result: ScriptResult = await execPython(scriptPath, args);
        dataResults[idx] = { role: cfg.role, result };
      } catch (err: any) {
        dataResults[idx] = { role: cfg.role, result: { success: false, error: err.message } as ScriptResult };
      }
    },
    dataConcurrency,
    1500  // stagger: 0~1.5s jitter between data script starts (Eastmoney rate limit)
  );

  const dataMap: Record<string, string> = {};
  for (const { role, result } of dataResults) {
    if (result.success && result.data) {
      dataMap[role] = JSON.stringify(result.data, null, 2);
    } else {
      dataMap[role] = `[数据缺失: ${result.error || "unknown error"}]`;
    }
  }

  // ── Phase 2: Run all 7 analysts with concurrency limit ─────────
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const analystReports: AnalystReport[] = new Array(ANALYST_CONFIGS.length);
  const concurrency = config.llm_concurrency || 3;

  await pool(
    ANALYST_CONFIGS,
    async (cfg, idx) => {
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

        analystReports[idx] = {
          role: cfg.role,
          content: llmResult.content,
          verdict: verdict || { direction: "中性", reason: "无法解析结论" },
          data_sources_used: [cfg.dataKey],
        } as AnalystReport;
      } catch (err: any) {
        analystReports[idx] = {
          role: cfg.role,
          content: `[分析失败: ${err.message}]`,
          verdict: { direction: "中性", reason: "分析失败" },
          data_sources_used: [],
        } as AnalystReport;
      }
    },
    concurrency,
    800  // stagger: 0~0.8s jitter between LLM calls (API rate limit)
  );

  return { analystReports, totalTokens, totalCostUsd };
}

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

  const { analystReports, totalTokens, totalCostUsd } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger);

  // ── Portfolio Manager ────────────────────────────────────────────
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
  const allReportsText = analystReports
    .map((r) => `## ${r.role} 分析师报告\n\n${r.content}\n\nVERDICT: ${r.verdict.direction} — ${r.verdict.reason}`)
    .join("\n\n---\n\n");

  const portfolioPrompt = loadAndRender("portfolio_manager.md", { ticker, date, analyst_reports: allReportsText }, promptsBaseDir);

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

  const allTokens = totalTokens + portfolioResult.usage.total_tokens;
  const allCost = totalCostUsd + portfolioResult.costUsd;

  const portfolioVerdict = parseVerdict(portfolioResult.content);
  if (!portfolioVerdict) {
    throw new Error("Failed to parse portfolio manager verdict from LLM response");
  }

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

  const result: QuickAnalysisResult = { ticker, date, mode: "quick", analysts: analystReports, final: finalDecision };
  const durationMs = Date.now() - startTime;
  reportStore.save(ticker, date, "quick", result, durationMs, allTokens, allCost);
  return result;
}

/**
 * Run full analysis with debate and risk layers:
 * 1. 7 analysts (parallel) → 2. Bull↔Bear debate → 3. Research Manager
 * 4. Trader → 5. Risk Debate (3-way parallel) → 6. Risk Manager (with revise loop)
 */
export async function runFullAnalysis(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI
): Promise<FullAnalysisResult> {
  const startTime = Date.now();
  const traceDir = path.join(os.homedir(), ".openclaw", "traces", `${ticker}_${date}_full`);
  const traceLogger = new TraceLogger(traceDir);
  const reportStore = new ReportStore(config.report_dir);

  // Phase 1-2: Analysts
  const { analystReports } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger);

  // Phase 3: Bull↔Bear Debate
  const debate = await runBullBearDebate(analystReports, config, openaiClient, traceLogger);

  // Phase 4: Research Manager
  const researchDecision = await runResearchManager(analystReports, debate, config, openaiClient, traceLogger);

  // Phase 5: Trader (with revise loop)
  let tradingPlan = await runTrader(researchDecision, analystReports, config, openaiClient, traceLogger, ticker, date);

  // Phase 6-7: Risk Debate + Risk Manager (with revise loop)
  let riskDebate = await runRiskDebate(tradingPlan, analystReports, config, openaiClient, traceLogger);
  let riskAssessment = await runRiskManager(riskDebate, tradingPlan, config, openaiClient, traceLogger);

  let retries = 0;
  while (riskAssessment.status === "revise" && retries < config.max_risk_retries) {
    retries++;
    tradingPlan = await runTrader(researchDecision, analystReports, config, openaiClient, traceLogger, ticker, date);
    if (riskAssessment.max_position_override) {
      tradingPlan.position_pct = Math.min(tradingPlan.position_pct, riskAssessment.max_position_override);
    }
    riskDebate = await runRiskDebate(tradingPlan, analystReports, config, openaiClient, traceLogger);
    riskAssessment = await runRiskManager(riskDebate, tradingPlan, config, openaiClient, traceLogger);
  }

  // If still revise after max retries, treat as pass
  if (riskAssessment.status === "revise") {
    riskAssessment = { ...riskAssessment, status: "pass" };
  }

  // Assemble FinalDecision
  const analystVerdicts: Record<string, string> = {};
  for (const report of analystReports) {
    analystVerdicts[report.role] = report.verdict.direction;
  }

  const finalDecision: FinalDecision = {
    ticker,
    company_name: ticker,
    date,
    direction: tradingPlan.direction,
    confidence: researchDecision.confidence,
    target_price: tradingPlan.target_price,
    stop_loss: tradingPlan.stop_loss,
    position_pct: tradingPlan.position_pct,
    reasoning: researchDecision.reasoning,
    key_risks: tradingPlan.key_risks,
    analyst_verdicts: analystVerdicts,
    bull_bear_summary: `Bull: ${debate.bull_summary}\nBear: ${debate.bear_summary}`,
    risk_assessment: riskAssessment.status,
    execution_plan: tradingPlan.execution_plan,
    next_review_trigger: "",
  };

  const result: FullAnalysisResult = {
    ticker,
    date,
    mode: "full",
    analysts: analystReports,
    debate,
    research_decision: researchDecision,
    trading_plan: tradingPlan,
    risk_debate: riskDebate,
    risk_assessment: riskAssessment,
    final: finalDecision,
  };

  const durationMs = Date.now() - startTime;
  reportStore.saveFull(ticker, date, result, durationMs);
  return result;
}
