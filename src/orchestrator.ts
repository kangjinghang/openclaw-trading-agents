// src/orchestrator.ts

import OpenAI from "openai";
import { execPython } from "./exec-python";
import { PYTHON_SCRIPT_TIMEOUT_MS } from "./constants";
import { loadAndRender } from "./prompt-loader";
import { callLLM, parseVerdict } from "./llm-client";
import { TraceLogger } from "./trace-logger";
import { ReportStore } from "./report-store";
import { runBullBearDebate } from "./debate";
import { runResearchManager } from "./research-manager";
import { runTrader } from "./trader";
import { runRiskDebate, runRiskManager } from "./risk";
import { validateAnalystReports } from "./quality-gate";
import { runQualityReview, formatQualityReview } from "./quality-review";
import {
  TradingAgentsConfig,
  QuickAnalysisResult,
  FullAnalysisResult,
  AnalystReport,
  FinalDecision,
  ScriptResult,
  RunMeta,
  QualitySummary,
} from "./types";
import { AbortError, ParseError, EnvironmentError } from "./errors";
import { DATA_FETCH_STAGGER_MS, LLM_CALL_STAGGER_MS, DEFAULT_CONCURRENCY } from "./constants";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

// ── Market-data completeness thresholds ───────────────────────────
// These catch the two most dangerous silent failures: K-line returned far
// fewer bars than requested, or the source silently returned stale data.
// Tuned conservative to avoid false positives (新股/停牌/回测):
//  - MIN_BARS is an absolute floor, not a ratio, so newly-listed stocks
//    that simply have <50 bars of history are flagged correctly (TI needs
//    ≥50) without penalizing normal short-history tickers disproportionately.
//  - Freshness is checked ONLY when --date is within RECENT_WINDOW_DAYS of
//    today, so backtesting with an old --date never trips it. The stale gap
//    tolerance absorbs weekends + short holidays.
const KLINE_MIN_BARS = 50; // technical indicators (MACD/RSI/...) need ≥50 bars
const FRESHNESS_RECENT_WINDOW_DAYS = 7; // only check freshness for near-term analysis
const FRESHNESS_STALE_GAP_DAYS = 7; // weekend (~3d) + short-holiday headroom

/** Parse a "YYYY-MM-DD" prefix out of an arbitrary date-ish string. Returns null if none. */
function extractDateStr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Whole-day distance between two "YYYY-MM-DD" strings. 0 if either is unparseable. */
function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.abs(Math.round((tb - ta) / 86_400_000));
}

/** Is `date` within `windowDays` of `nowMs`? Used to gate freshness checks to near-term analysis. */
function isRecentDate(date: string, windowDays: number, nowMs: number = Date.now()): boolean {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return false;
  return Math.abs(Math.round((nowMs - t) / 86_400_000)) <= windowDays;
}

/** Generate a data quality description for an analyst based on their ScriptResult. */
export function generateDataQuality(role: string, date: string, result: ScriptResult): string {
  if (!result.success) {
    return "⚠️ 数据缺失：数据源获取失败，以下分析中必须明确声明数据不可用，不得推测或编造数据。置信度应降低。";
  }

  const issues: string[] = [];

  // Check for partial errors
  if (result.error) {
    issues.push(`数据源返回错误: ${result.error}`);
  }

  // Check data richness
  const data = result.data;
  if (data) {
    const fieldCount = Object.keys(data).length;
    const hasErrorFields = Object.keys(data).some(k => k.endsWith('_error'));

    if (hasErrorFields) {
      const errorFields = Object.keys(data).filter(k => k.endsWith('_error'));
      issues.push(`部分数据缺失: ${errorFields.map(k => k.replace('_error', '')).join(', ')}。请在分析中区分有数据支撑的结论和推测性结论。`);
    }

    if (fieldCount < 3) {
      issues.push(`数据字段较少（仅 ${fieldCount} 个字段），置信度应适当降低。`);
    }

    // Market-role completeness: K-line is the foundation of every downstream
    // judgment, so row-count and freshness get a dedicated, stricter check.
    if (role === "market") {
      const klineArr = Array.isArray((data as any).data) ? (data as any).data as unknown[] : null;
      const rowCount = typeof (data as any).count === "number"
        ? (data as any).count
        : (klineArr?.length ?? 0);

      if (rowCount < KLINE_MIN_BARS) {
        issues.push(`K线仅 ${rowCount} 根（技术指标需 ≥${KLINE_MIN_BARS} 根），MACD/RSI/布林带等可能缺失，趋势判断不可靠，置信度应显著降低。`);
      }

      if (klineArr && klineArr.length > 0 && isRecentDate(date, FRESHNESS_RECENT_WINDOW_DAYS)) {
        const latestBarDate = extractDateStr((klineArr[klineArr.length - 1] as any)?.date);
        const analysisDate = extractDateStr(date);
        if (latestBarDate && analysisDate) {
          const gapDays = daysBetween(latestBarDate, analysisDate);
          if (gapDays > FRESHNESS_STALE_GAP_DAYS) {
            issues.push(`K线最新数据为 ${latestBarDate}，距分析日 ${analysisDate} 已 ${gapDays} 天，数据可能过期（停牌或数据源异常），置信度应降低。`);
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    return `⚠️ 数据部分缺失：${issues.join(' ')}`;
  }

  return "✅ 数据完整：数据源获取正常，所有字段可用。可以正常进行分析和判断。";
}

/** Generate analyst consensus summary from all analyst reports */
function generateAnalystConsensus(reports: AnalystReport[]): string {
  const validReports = reports.filter(r => !r.content.startsWith("[分析失败"));
  if (validReports.length === 0) {
    return "⚠️ 所有分析师报告均失败，无法计算一致性指标。";
  }

  const directionCounts: Record<string, { count: number; roles: string[] }> = {};
  for (const report of validReports) {
    const dir = report.verdict.direction;
    if (!directionCounts[dir]) {
      directionCounts[dir] = { count: 0, roles: [] };
    }
    directionCounts[dir].count++;
    directionCounts[dir].roles.push(report.role);
  }

  const sorted = Object.entries(directionCounts).sort((a, b) => b[1].count - a[1].count);
  const total = validReports.length;

  const lines: string[] = [
    `### 分析师一致性指标（共 ${total} 位分析师）\n`,
  ];

  for (const [dir, info] of sorted) {
    const pct = Math.round(info.count / total * 100);
    lines.push(`- **${dir}**: ${info.count}/${total} (${pct}%) — ${info.roles.join(', ')}`);
  }

  const topDir = sorted[0][0];
  const topCount = sorted[0][1].count;
  const topPct = Math.round(topCount / total * 100);

  let divergence: string;
  if (topPct >= 70) {
    divergence = "低（高度一致）";
  } else if (topPct >= 50) {
    divergence = "中（多数一致）";
  } else {
    divergence = "高（分歧较大）";
  }

  lines.push(`\n**共识方向**: ${topDir} | **一致比例**: ${topPct}% | **分歧度**: ${divergence}`);

  // Decision guidance
  lines.push("\n**决策指引**:");
  if (topPct >= 70) {
    lines.push(`- 分析师高度一致（${topPct}% ${topDir}），可提高决策置信度`);
  } else if (topPct >= 50) {
    lines.push(`- 多数分析师一致（${topPct}% ${topDir}），建议适当降低仓位`);
  } else {
    lines.push(`- 分析师分歧较大（最高 ${topPct}% ${topDir}），建议降低仓位或持有观望`);
  }

  return lines.join("\n");
}

/** Pre-run validation: check environment before starting analysis */
function validateEnvironment(reportDir: string): void {
  const errors: string[] = [];

  // Check report_dir is writable
  try {
    const absDir = reportDir.replace("~", os.homedir());
    fs.mkdirSync(absDir, { recursive: true });
    const testFile = path.join(absDir, ".write-test");
    fs.writeFileSync(testFile, "test", "utf-8");
    fs.unlinkSync(testFile);
  } catch (err: any) {
    errors.push(`report_dir "${reportDir}" is not writable: ${err.message}`);
  }

  // Check skills directory exists
  if (!fs.existsSync(SKILLS_DIR)) {
    errors.push(`skills directory not found: ${SKILLS_DIR}`);
  }

  if (errors.length > 0) {
    throw new EnvironmentError(`环境预检失败:\n  ${errors.join("\n  ")}`);
  }
}

/** Generate a short run ID for log correlation */
function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
}

/** Structured progress log to stderr */
function logProgress(runId: string, message: string, tokens?: number, costUsd?: number): void {
  const ts = new Date().toISOString().slice(11, 19);
  let suffix = "";
  if (tokens !== undefined && costUsd !== undefined) {
    suffix = ` — ${tokens.toLocaleString()} tokens, $${costUsd.toFixed(4)}`;
  }
  console.error(`  [${ts}] [${runId.slice(0, 12)}] ${message}${suffix}`);
}

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
    extraArgs: (_ticker: string) => ["--count", "120"],
    timeoutMs: 60_000, // K-line fetch + VPA + technical indicators can be slow
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

/** Get timeout for an analyst config, defaulting to PYTHON_SCRIPT_TIMEOUT_MS */
function scriptTimeout(cfg: typeof ANALYST_CONFIGS[number]): number {
  return (cfg as any).timeoutMs ?? PYTHON_SCRIPT_TIMEOUT_MS;
}

/** Save raw data source outputs to the report directory for traceability */
function saveRawData(
  detailDir: string,
  dataResults: Array<{ role: string; result: ScriptResult }>,
  subDirName: string
): void {
  const dataDir = path.join(detailDir, subDirName);
  fs.mkdirSync(dataDir, { recursive: true });
  for (const { role, result } of dataResults) {
    if (!result) continue;
    const filePath = path.join(dataDir, `${role}_raw.json`);
    try {
      const tmpPath = filePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.error(`[saveRawData] Failed to write ${role}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Shared Phase 1-2: fetch data + run 7 analysts in parallel.
 * Used by both runQuickAnalysis() and runFullAnalysis().
 */
async function runAnalystPhase(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger,
  runId: string
): Promise<{ analystReports: AnalystReport[]; totalTokens: number; totalCostUsd: number; dataResults: Array<{ role: string; result: ScriptResult }> }> {
  let totalTokens = 0;
  let totalCostUsd = 0;

  // ── Phase 1: Fetch data from all 7 scripts with concurrency limit ──
  logProgress(runId, "[1/4] 数据采集 7 个数据源...");
  const dataConcurrency = config.llm_concurrency || DEFAULT_CONCURRENCY;
  const dataResults: Array<{ role: string; result: ScriptResult }> = new Array(ANALYST_CONFIGS.length);

  await pool(
    ANALYST_CONFIGS,
    async (cfg, idx) => {
      const scriptPath = path.join(SKILLS_DIR, cfg.script);
      const args = ["--ticker", ticker, "--date", date, ...cfg.extraArgs(ticker)];
      try {
        const result: ScriptResult = await execPython(scriptPath, args, null, 'python3', scriptTimeout(cfg));
        dataResults[idx] = { role: cfg.role, result };
        if (!result.success) {
          logProgress(runId, `  数据采集 ${cfg.role} 失败: ${result.error?.slice(0, 80)}`);
        }
      } catch (err: any) {
        dataResults[idx] = { role: cfg.role, result: { success: false, error: err.message } as ScriptResult };
        logProgress(runId, `  数据采集 ${cfg.role} 异常: ${err.message?.slice(0, 80)}`);
      }
    },
    dataConcurrency,
    DATA_FETCH_STAGGER_MS
  );

  const dataFailed = dataResults.filter(d => !d.result.success).length;
  logProgress(runId, `[1/4] 数据采集完成 (${ANALYST_CONFIGS.length - dataFailed}/${ANALYST_CONFIGS.length} 成功${dataFailed > 0 ? `, ${dataFailed} 失败` : ""})`);

  const dataMap: Record<string, string> = {};
  const vpaMap: Record<string, string> = {};
  const tiMap: Record<string, string> = {};
  const dataQualityMap: Record<string, string> = {};
  for (const { role, result } of dataResults) {
    if (result.success && result.data) {
      dataMap[role] = JSON.stringify(result.data, null, 2);
      if (result.vpa) {
        vpaMap[role] = result.vpa;
      }
      if (result.technical_indicators) {
        tiMap[role] = result.technical_indicators;
      }
    } else {
      dataMap[role] = `[数据缺失: ${result.error || "unknown error"}]`;
    }
    dataQualityMap[role] = generateDataQuality(role, date, result);
  }

  // ── Phase 2: Run all 7 analysts with concurrency limit ─────────
  logProgress(runId, "[2/4] 分析师阶段 7 个分析师...");
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const analystReports: AnalystReport[] = new Array(ANALYST_CONFIGS.length);
  const concurrency = config.llm_concurrency || DEFAULT_CONCURRENCY;

  await pool(
    ANALYST_CONFIGS,
    async (cfg, idx) => {
      try {
        const dataJson = dataMap[cfg.role];
        const userMessage = loadAndRender(
          cfg.prompt,
          { ticker, date, [cfg.dataKey]: dataJson, vpa: vpaMap[cfg.role] || "", technical_indicators: tiMap[cfg.role] || "", data_quality: dataQualityMap[cfg.role] },
          promptsBaseDir
        );

        const llmResult = await callLLM(openaiClient, {
          model: config.models.analyst,
          systemPrompt: cfg.systemPrompt,
          userMessage,
          temperature: 0.4,
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
        logProgress(runId, `  分析师 ${cfg.role} 失败: ${err.message?.slice(0, 80)}`);
        analystReports[idx] = {
          role: cfg.role,
          content: `[分析失败: ${err.message}]`,
          verdict: { direction: "中性", reason: "分析失败" },
          data_sources_used: [],
        } as AnalystReport;
      }
    },
    concurrency,
    LLM_CALL_STAGGER_MS
  );

  const analystEmpty = analystReports.filter(r => r.content.startsWith("[分析失败")).length;
  logProgress(runId, `[2/4] 分析师阶段完成${analystEmpty > 0 ? ` (${analystEmpty} 个失败)` : ""}`);

  return { analystReports, totalTokens, totalCostUsd, dataResults };
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
  openaiClient: OpenAI,
  signal?: AbortSignal
): Promise<[QuickAnalysisResult, RunMeta]> {
  const startTime = Date.now();
  const runId = generateRunId();
  const detailDir = path.join(config.report_dir.replace("~", os.homedir()), ticker, `${date}_quick`);
  const traceDir = path.join(detailDir, "02_traces");
  const traceLogger = new TraceLogger(traceDir, runId);
  const reportStore = new ReportStore(config.report_dir);

  logProgress(runId, `开始 Quick 分析 ${ticker} (${date})`);
  validateEnvironment(config.report_dir);

  const { analystReports, totalTokens, totalCostUsd, dataResults } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId);

  if (signal?.aborted) throw new AbortError();

  // ── Quality Gate ──────────────────────────────────────────────────
  const quality = validateAnalystReports(analystReports);
  // Layer-2 LLM credibility review (optional; degrades to Layer-1 on skip/failure)
  const qualityReview = await runQualityReview(analystReports, quality, ticker, date, config, openaiClient, traceLogger);
  if (qualityReview) quality.summary_text += formatQualityReview(qualityReview);
  logProgress(runId, `[2/4] 质量门控: ${quality.grades.map(g => `${g.role}=${g.grade}`).join(", ")}${qualityReview ? ` (可信度 ${qualityReview.credibility})` : ""}`);

  // ── Portfolio Manager ────────────────────────────────────────────
  logProgress(runId, "[3/4] 投资组合经理决策...");
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
  const allReportsText = analystReports
    .map((r) => `## ${r.role} 分析师报告\n\n${r.content}\n\nVERDICT: ${r.verdict.direction} — ${r.verdict.reason}`)
    .join("\n\n---\n\n");

  const analystConsensus = generateAnalystConsensus(analystReports);

  const portfolioPrompt = loadAndRender("portfolio_manager.md", { ticker, date, analyst_reports: allReportsText, quality_summary: quality.summary_text, analyst_consensus: analystConsensus }, promptsBaseDir);

  const portfolioResult = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt: "You are a portfolio manager making final trading decisions based on analyst reports.",
    userMessage: portfolioPrompt,
    temperature: 0.3,
    phase: "portfolio",
    role: "portfolio_manager",
    traceLogger,
  });

  const allTokens = totalTokens + portfolioResult.usage.total_tokens;
  const allCost = totalCostUsd + portfolioResult.costUsd;

  const portfolioVerdict = parseVerdict(portfolioResult.content);
  let direction: FinalDecision["direction"];
  let reasoning: string;

  if (portfolioVerdict) {
    direction = parseDirection(portfolioVerdict.direction);
    reasoning = portfolioVerdict.reason;
  } else {
    // Fallback: majority vote from analysts
    logProgress(runId, "  WARNING: 投资组合经理结论解析失败，使用分析师多数意见");
    const verdictCounts: Record<string, number> = {};
    for (const report of analystReports) {
      verdictCounts[report.verdict.direction] = (verdictCounts[report.verdict.direction] || 0) + 1;
    }
    const majority = Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])[0][0];
    direction = parseDirection(majority);
    reasoning = `投资组合经理解析失败，使用分析师多数意见 (${majority})`;
  }

  const analystVerdicts: Record<string, string> = {};
  for (const report of analystReports) {
    analystVerdicts[report.role] = report.verdict.direction;
  }

  const finalDecision: FinalDecision = {
    ticker,
    company_name: ticker,
    date,
    direction,
    confidence: 0.7,
    target_price: 0,
    stop_loss: 0,
    position_pct: 0,
    reasoning,
    key_risks: [],
    analyst_verdicts: analystVerdicts,
    bull_bear_summary: "",
    risk_assessment: "pass",
    execution_plan: "",
    next_review_trigger: "",
  };

  const result: QuickAnalysisResult = { ticker, date, mode: "quick", analysts: analystReports, final: finalDecision };
  const durationMs = Date.now() - startTime;

  logProgress(runId, `[4/4] 保存报告...`);
  reportStore.save(ticker, date, "quick", result, durationMs, allTokens, allCost, runId);
  saveRawData(detailDir, dataResults, "03_data");
  logProgress(runId, `完成 (${(durationMs / 1000).toFixed(1)}s)`, allTokens, allCost);

  // Write run summary for auditing
  const meta: RunMeta = {
    run_id: runId,
    trace_dir: traceDir,
    duration_ms: durationMs,
    total_tokens: allTokens,
    total_cost_usd: allCost,
    llm_call_count: traceLogger.count,
  };
  fs.writeFileSync(path.join(traceDir, "run_summary.json"), JSON.stringify({ ...meta, ticker, date, mode: "quick", direction }, null, 2), "utf-8");

  return [result, meta];
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
  openaiClient: OpenAI,
  signal?: AbortSignal
): Promise<[FullAnalysisResult, RunMeta]> {
  const startTime = Date.now();
  const runId = generateRunId();
  const detailDir = path.join(config.report_dir.replace("~", os.homedir()), ticker, `${date}_full`);
  const traceDir = path.join(detailDir, "06_traces");
  const traceLogger = new TraceLogger(traceDir, runId);
  const reportStore = new ReportStore(config.report_dir);

  logProgress(runId, `开始 Full 分析 ${ticker} (${date})`);
  validateEnvironment(config.report_dir);

  // Phase 1-2: Analysts
  const { analystReports, dataResults } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId);

  if (signal?.aborted) throw new AbortError();

  // Quality Gate
  const quality = validateAnalystReports(analystReports);
  // Layer-2 LLM credibility review (optional; degrades to Layer-1 on skip/failure)
  const qualityReview = await runQualityReview(analystReports, quality, ticker, date, config, openaiClient, traceLogger);
  if (qualityReview) quality.summary_text += formatQualityReview(qualityReview);
  logProgress(runId, `质量门控: ${quality.grades.map(g => `${g.role}=${g.grade}`).join(", ")}${qualityReview ? ` (可信度 ${qualityReview.credibility})` : ""}`);

  // Phase 3: Bull↔Bear Debate
  logProgress(runId, `[3/7] 多空辩论 (${config.debate_rounds} 轮)...`);
  const debate = await runBullBearDebate(analystReports, quality.summary_text, config, openaiClient, traceLogger);
  logProgress(runId, `[3/7] 多空辩论完成 (Bull ${debate.rounds.flatMap(r => r.bull_claims).length} claims, Bear ${debate.rounds.flatMap(r => r.bear_claims).length} claims)`);

  if (signal?.aborted) throw new AbortError();

  // Phase 4: Research Manager
  logProgress(runId, `[4/7] 研究经理裁决...`);
  const researchDecision = await runResearchManager(analystReports, debate, quality.summary_text, config, openaiClient, traceLogger);
  logProgress(runId, `[4/7] 研究经理裁决: ${researchDecision.direction} (信心 ${researchDecision.confidence})`);

  if (signal?.aborted) throw new AbortError();

  // Phase 5: Trader
  logProgress(runId, `[5/7] 交易员制定执行计划...`);
  let tradingPlan = await runTrader(researchDecision, analystReports, quality.summary_text, config, openaiClient, traceLogger, ticker, date);
  logProgress(runId, `[5/7] 交易计划: ${tradingPlan.direction} 目标价 ${tradingPlan.target_price} 止损 ${tradingPlan.stop_loss}`);

  if (signal?.aborted) throw new AbortError();

  // Phase 6-7: Risk Debate + Risk Manager (with revise loop)
  logProgress(runId, `[6/7] 风控辩论 (3 方)...`);
  let riskDebate = await runRiskDebate(tradingPlan, analystReports, config, openaiClient, traceLogger);
  logProgress(runId, `[6/7] 风控辩论完成`);

  logProgress(runId, `[7/7] 风控经理评估...`);
  let riskAssessment = await runRiskManager(riskDebate, tradingPlan, config, openaiClient, traceLogger);

  let retries = 0;
  while (riskAssessment.status === "revise" && retries < config.max_risk_retries) {
    retries++;
    logProgress(runId, `  风控要求修订 (${retries}/${config.max_risk_retries}), 重新生成交易计划...`);
    // Inject the prior risk constraints into the trader so the revised plan
    // actually addresses them (instead of a blind retry). max_position_override
    // remains as a hard numeric cap fallback in case the LLM ignores hard_constraints.
    tradingPlan = await runTrader(researchDecision, analystReports, quality.summary_text, config, openaiClient, traceLogger, ticker, date, riskAssessment.judge);
    if (riskAssessment.max_position_override) {
      tradingPlan.position_pct = Math.min(tradingPlan.position_pct, riskAssessment.max_position_override);
    }
    riskDebate = await runRiskDebate(tradingPlan, analystReports, config, openaiClient, traceLogger);
    riskAssessment = await runRiskManager(riskDebate, tradingPlan, config, openaiClient, traceLogger);
  }

  // If still revise after max retries, treat as pass
  if (riskAssessment.status === "revise") {
    logProgress(runId, `  风控修订次数已达上限，视为通过`);
    riskAssessment = { ...riskAssessment, status: "pass" };
  }

  logProgress(runId, `[7/7] 风控评估: ${riskAssessment.status} (风险评分 ${riskAssessment.risk_score})`);

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
  reportStore.saveFull(ticker, date, result, durationMs, runId);
  saveRawData(detailDir, dataResults, "07_data");
  logProgress(runId, `完成 (${(durationMs / 1000).toFixed(1)}s, ${traceLogger.count} LLM calls)`, traceLogger.totalTokens, traceLogger.totalCostUsd);

  // Write run summary for auditing
  const meta: RunMeta = {
    run_id: runId,
    trace_dir: traceDir,
    duration_ms: durationMs,
    total_tokens: traceLogger.totalTokens,
    total_cost_usd: traceLogger.totalCostUsd,
    llm_call_count: traceLogger.count,
  };
  fs.writeFileSync(path.join(traceDir, "run_summary.json"), JSON.stringify({ ...meta, ticker, date, mode: "full", direction: tradingPlan.direction }, null, 2), "utf-8");

  return [result, meta];
}
