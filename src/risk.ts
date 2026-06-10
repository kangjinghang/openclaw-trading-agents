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

export const RISK_ROLES: Array<{
  role: RiskArgument["role"];
  instructions: string;
}> = [
  {
    role: "aggressive",
    instructions:
      "你倾向于支持交易计划，做多风险因素的强势倡导者——不是无条件唱多，而是穷尽可行证据、在辩论中反驳保守方的悲观论调。从以下 A 股维度论证上行：(1) 政策底与产业催化：国务院/部委级扶持文件构成「政策底」，专项扶持、产业补贴、注册制红利是上行燃料；(2) 北向资金确认：沪深股通持续净流入是外资真金白银的背书，属趋势确认而非噪音；(3) 涨停板动量：T+1 反而抑制日内获利了结、利于多日连板，首板放量/缩量与龙头高度反映主力意志；(4) PE 扩张阶段：A 股牛市中成长股 PE 常扩张至 50-100x，过早套用美股 15-25x 会错过主升浪——以 30x 消化时间为锚，但 PEG<1 的高增速可容忍更高 PE；(5) 散户与游资放大器：散户占比高、羊群效应放大涨幅，游资接力制造短期强势。立场须有数据支撑，但你的任务是穷尽做多理由。",
  },
  {
    role: "conservative",
    instructions:
      "你倾向于审慎评估风险，做结构性风险的吹哨人——不是无条件看空，而是聚焦让多头计划崩塌的具体机制、在辩论中戳破乐观方的脆弱论据。从以下 A 股维度论证下行：(1) T+1 锁定风险（A 股最重大的结构性风险）：当日买入次日才能卖，开盘跳空下杀时损失被锁定、无法止损，急涨后追入者次日遇抛压即被套；(2) 涨跌停板陷阱：跌停板上卖单无法成交、被「焊死」，连续跌停可造成灾难性损失且无法离场；(3) 解禁与减持压力：解禁市值/流通市值 >20% 为重大压力，叠加减持新规抛压，是悬在头上的「卖出期权」、压制上行空间；(4) 政策反转风险：政策市的双刃剑——政府给的可以一夜收回，窗口指导、行业整顿可瞬时逆转预期；(5) 游资撤退信号：放量滞涨、连板断裂、龙头补跌是离场前兆；(6) 估值纪律：PE>50x 且 PEG>2 属投机，以 30x 锚消化需 5 年以上则明显高估；ST/退市风险须纳入仓位考量。你的任务是让风控经理看见最坏情况。",
  },
  {
    role: "neutral",
    instructions:
      "你持中立立场，做条件性、可证伪的平衡评估——不站队多空，而是把激进/保守两方论点拆解为可验证的条件、指出各自何时成立。核心视角：(1) T+1 是双刃剑：既锁定损失（保守方观点），也抑制恐慌抛售、利于多日趋势延续（激进方观点）——中立结论是仓位须小到能扛住单日跳空；(2) 政策信号分层：区分国务院顶层指令（高确定性）vs 部委通知（中等）vs 地方激励（较低可靠性）vs 市场传闻（噪音），据此给政策催化打折；(3) 北向资金定位：作为趋势确认信号而非独立做多理由，背离时是警示；(4) 估值区间法（非刚性阈值）：给定盈利轨迹下提出可辩护的 PE 区间而非单一阈值；(5) 板块轮动周期：A 股题材轮动快（典型 2-4 周），判断处于轮动早期（空间仍在）还是末期（上行有限、下行放大）；(6) 仓位管理优先于方向判断：在 ±10-20% 涨跌停 + T+1 的市场里，「买多少」比「买不买」更重要——这是中立派对 A 股风险的核心命题。你的任务是给出计划在何种条件下成立/不成立的分情景判断。",
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

/**
 * Extract a numeric total-position cap (%) from `hard_constraints` text like
 * "总仓位≤10%", "仓位不超过20%", "最终持仓≤30%". Returns the SMALLEST cap found
 * (most restrictive) when multiple constraints apply. Returns undefined when
 * no total-position constraint is present — callers treat undefined as "no
 * override" and leave position_pct unchanged.
 *
 * Matches both "仓位" and "持仓" — they're synonyms in A-share trading and the
 * LLM emits either (600600 real run used "最终持仓≤30%"; an earlier run used
 * "总仓位≤10%"). The % sign is REQUIRED: it's what distinguishes a position-
 * PERCENT cap from an absolute-quantity constraint like "持仓量≤100万手"
 * (open interest) or "持仓≤1000股" (share count), which must NOT be treated
 * as a percentage cap.
 *
 * Why text extraction instead of a dedicated RISK_JUDGE field: the cap already
 * lives in hard_constraints (the LLM emits it there naturally — confirmed on
 * 600600); adding a parallel numeric field risks the two disagreeing. Zero
 * extra LLM cost, deterministic.
 *
 * Sub-batch constraints ("首批建仓≤5%", "首笔仓位≤3%", "分批…", "加仓…") are
 * explicitly skipped — they cap a tranche, not the total.
 */
export function extractPositionCap(
  hardConstraints: string[] | undefined
): number | undefined {
  if (!hardConstraints || hardConstraints.length === 0) return undefined;
  const caps: number[] = [];
  for (const c of hardConstraints) {
    // Skip sub-batch constraints — they're not total-position caps.
    if (/首批|首笔|首次|分批|加仓/.test(c)) continue;
    // Match 仓位 OR 持仓 (synonyms in A-share trading). The % sign is REQUIRED:
    // it's what distinguishes a position-PERCENT cap ("仓位≤30%") from an
    // absolute-quantity constraint ("持仓量≤100万手" = open interest, no %).
    const m = c.match(/(?:仓位|持仓)\s*(?:≤|<=|不超过|不多于|最多|上限)\s*(\d{1,3})\s*%/);
    if (m) {
      const val = parseInt(m[1], 10);
      if (val > 0 && val <= 100) caps.push(val);
    }
  }
  return caps.length > 0 ? Math.min(...caps) : undefined;
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
    model: config.models.decision_deep || config.models.risk,
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

  let status: RiskAssessment["status"];
  if (!judge && !verdict) {
    // Scariest fallback: nothing parseable → status silently "pass". Surface
    // it as an error so a reviewer sees the plan was rubber-stamped by default.
    status = "pass";
    traceLogger.recordWarning({
      phase: "risk",
      fn: "runRiskManager",
      detail: "RISK_JUDGE 与 VERDICT 均缺失，status 默认 pass（无法解析风控结论）",
      severity: "error",
    });
  } else {
    status = (judge?.verdict || verdict!.direction || "pass").toLowerCase() as RiskAssessment["status"];
  }

  const max_position_override = extractPositionCap(judge?.hard_constraints);
  // Risk produced hard constraints but none yielded a position-% cap → the
  // plan's position_pct is uncapped. This is the class behind the 600600
  // "judge says ≤10% but position stayed 15%" regression (a cap the regex
  // couldn't extract). Only warn when there's a real position to cap.
  if (judge && judge.hard_constraints.length > 0 && max_position_override === undefined && tradingPlan.position_pct > 0) {
    traceLogger.recordWarning({
      phase: "risk",
      fn: "extractPositionCap",
      detail: `有 ${judge.hard_constraints.length} 条硬约束但未提取到仓位% cap，position_pct=${tradingPlan.position_pct}% 未被风控约束`,
      severity: "warn",
    });
  }

  const scoreMatch = result.content.match(/风险评分[（(]0-100[)）]?[：:]*\s*\n?\s*(\d+)/) ||
                     result.content.match(/risk.?score[：:]*\s*\n?\s*(\d+)/i);

  return {
    status,
    judge: judge ?? undefined,
    reasoning: judge?.reason || verdict?.reason || "",
    risk_score: scoreMatch ? parseInt(scoreMatch[1], 10) : 50,
    max_position_override,
  };
}
