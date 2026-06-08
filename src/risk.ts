// src/risk.ts

import OpenAI from "openai";
import { callLLM, parseVerdict } from "./llm-client";
import { loadAndRender } from "./prompt-loader";
import { TraceLogger } from "./trace-logger";
import {
  TradingAgentsConfig,
  AnalystReport,
  TradingPlan,
  RiskArgument,
  RiskDebateResult,
  RiskAssessment,
  RiskJudge,
} from "./types";
import { LLM_CALL_STAGGER_MS, DEFAULT_CONCURRENCY } from "./constants";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

/** Run tasks with limited concurrency and staggered start */
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

const RISK_ROLES: Array<{
  role: RiskArgument["role"];
  instructions: string;
}> = [
  {
    role: "aggressive",
    instructions: "你倾向于支持交易计划。重点关注政策底信号、北向资金确认、涨停板效应、市场情绪亢奋期、PE扩张阶段等看多风险因素。",
  },
  {
    role: "conservative",
    instructions: "你倾向于审慎评估风险。重点关注T+1锁定风险、涨跌停板陷阱、解禁压力、政策反转风险、游资撤退、估值纪律（PE>50x且PEG>2为投机）。",
  },
  {
    role: "neutral",
    instructions: "你持中立立场，综合评估风险与收益。关注T+1双刃剑效应、政策信号分层、北向资金作为确认信号而非主信号、估值区间法、仓位管理优先于方向判断。",
  },
];

function parseRiskArgument(content: string, role: RiskArgument["role"]): RiskArgument {
  const verdictMatch = content.match(/verdict[：:*]+\s*(pass|revise|reject)/i) ||
                       content.match(/结论[：:*]+\s*(pass|revise|reject|通过|修订|拒绝)/i);
  let verdict: RiskArgument["verdict"] = "pass";
  if (verdictMatch) {
    const raw = verdictMatch[1].toLowerCase();
    if (raw === "revise" || raw === "修订") verdict = "revise";
    else if (raw === "reject" || raw === "拒绝") verdict = "reject";
  }

  const evidenceSection = content.match(/### 2\. 证据支撑\s*\n([\s\S]*?)(?=\n###|$)/);
  const evidence = evidenceSection
    ? evidenceSection[1].split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean)
    : [];

  const positionMatch = content.match(/### 1\. 立场声明\s*\n(.+)/);

  return {
    role,
    position: positionMatch ? positionMatch[1].trim() : "",
    evidence,
    verdict,
  };
}

const RISK_VERDICTS = new Set(["pass", "revise", "reject"]);

/**
 * Parse a `<!-- RISK_JUDGE: {...} -->` JSON block from risk-manager output.
 * Returns null on: missing block, malformed JSON, non-object payload, or a
 * `verdict` value outside pass/revise/reject. Missing optional constraint
 * arrays are coerced to empty defaults so partial LLM output is still usable.
 */
export function parseRiskJudge(content: string): RiskJudge | null {
  const regex = /<!--\s*RISK_JUDGE:\s*(\{.*?\})\s*-->/s;
  const match = content.match(regex);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const verdictRaw = typeof obj.verdict === "string" ? obj.verdict.toLowerCase() : "";
  if (!RISK_VERDICTS.has(verdictRaw)) return null;

  const coerceStrArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    verdict: verdictRaw as RiskJudge["verdict"],
    reason: typeof obj.reason === "string" ? obj.reason : "",
    hard_constraints: coerceStrArray(obj.hard_constraints),
    soft_constraints: coerceStrArray(obj.soft_constraints),
    execution_preconditions: coerceStrArray(obj.execution_preconditions),
    de_risk_triggers: coerceStrArray(obj.de_risk_triggers),
  };
}

export async function runRiskDebate(
  tradingPlan: TradingPlan,
  analystReports: AnalystReport[],
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<RiskDebateResult> {
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const reportsText = analystReports
    .map((r) => `## ${r.role} 分析师\n${r.content}`)
    .join("\n\n");

  const planText = `方向：${tradingPlan.direction}\n目标价：${tradingPlan.target_price}\n止损：${tradingPlan.stop_loss}\n仓位：${tradingPlan.position_pct}%\n执行计划：${tradingPlan.execution_plan}`;

  const riskArguments: RiskArgument[] = new Array(RISK_ROLES.length);
  const concurrency = config.llm_concurrency || DEFAULT_CONCURRENCY;

  await pool(
    RISK_ROLES,
    async ({ role, instructions }, idx) => {
      const riskRoleLabel = role === "aggressive" ? "激进风控" : role === "conservative" ? "保守风控" : "中性风控";
      const userMessage = loadAndRender(
        "debate/risk_debater.md",
        {
          ticker: "",
          date: "",
          trading_plan: planText,
          analyst_reports: reportsText,
          risk_role: riskRoleLabel,
          risk_role_instructions: instructions,
        },
        promptsBaseDir
      );

      const result = await callLLM(openaiClient, {
        model: config.models.risk,
        systemPrompt: `You are a ${role} risk assessor for A-share trading.`,
        userMessage,
        temperature: 0.4,
        phase: "risk_debate",
        role: `${role}_risk`,
        traceLogger,
      });

      riskArguments[idx] = parseRiskArgument(result.content, role);
    },
    concurrency,
    LLM_CALL_STAGGER_MS
  );

  return {
    rounds: [riskArguments],
    risk_arguments: riskArguments,
    total_tokens: 0,
    total_cost_usd: 0,
  };
}

export async function runRiskManager(
  riskDebate: RiskDebateResult,
  tradingPlan: TradingPlan,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<RiskAssessment> {
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const planText = `方向：${tradingPlan.direction}\n目标价：${tradingPlan.target_price}\n止损：${tradingPlan.stop_loss}\n仓位：${tradingPlan.position_pct}%\n执行计划：${tradingPlan.execution_plan}`;

  const riskArgsText = riskDebate.risk_arguments
    .map((a) => `### ${a.role === "aggressive" ? "激进" : a.role === "conservative" ? "保守" : "中性"}风控\n立场：${a.position}\nverdict：${a.verdict}\n证据：${a.evidence.join("；")}`)
    .join("\n\n");

  const userMessage = loadAndRender(
    "debate/risk_manager.md",
    { ticker: "", date: "", trading_plan: planText, risk_arguments: riskArgsText },
    promptsBaseDir
  );

  const result = await callLLM(openaiClient, {
    model: config.models.risk,
    systemPrompt: "You are a risk manager making final pass/revise/reject decisions for A-share trading plans.",
    userMessage,
    temperature: 0.3,
    phase: "risk",
    role: "risk_manager",
    traceLogger,
  });

  // Prefer structured RISK_JUDGE block; fall back to VERDICT when absent.
  const judge = parseRiskJudge(result.content);
  const verdict = parseVerdict(result.content);
  const status = (judge?.verdict || verdict?.direction || "pass").toLowerCase() as RiskAssessment["status"];

  const scoreMatch = result.content.match(/风险评分[（(]0-100[)）]?[：:]*\s*\n?\s*(\d+)/) ||
                     result.content.match(/risk.?score[：:]*\s*\n?\s*(\d+)/i);

  return {
    status,
    judge: judge ?? undefined,
    reasoning: judge?.reason || verdict?.reason || "",
    risk_score: scoreMatch ? parseInt(scoreMatch[1], 10) : 50,
  };
}
