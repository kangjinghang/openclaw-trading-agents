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
} from "./types";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

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
  const verdictMatch = content.match(/\*\*verdict\*\*[：:]\s*(pass|revise|reject)/i);
  const verdict = verdictMatch ? verdictMatch[1].toLowerCase() as RiskArgument["verdict"] : "pass";

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

  const riskArguments = await Promise.all(
    RISK_ROLES.map(async ({ role, instructions }) => {
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
        maxTokens: 2000,
        phase: "risk_debate",
        role: `${role}_risk`,
        traceLogger,
      });

      return parseRiskArgument(result.content, role);
    })
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
    maxTokens: 2000,
    phase: "risk",
    role: "risk_manager",
    traceLogger,
  });

  const verdict = parseVerdict(result.content);
  const status = (verdict?.direction || "pass").toLowerCase() as RiskAssessment["status"];

  const scoreMatch = result.content.match(/风险评分[（(]0-100[)）]\s*\n(\d+)/);

  return {
    status,
    reasoning: verdict?.reason || "",
    risk_score: scoreMatch ? parseInt(scoreMatch[1], 10) : 50,
  };
}
