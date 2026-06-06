import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runRiskDebate, runRiskManager } from "../../src/risk";
import { TradingAgentsConfig, TradingPlan, RiskDebateResult } from "../../src/types";
import OpenAI from "openai";

const mockConfig: TradingAgentsConfig = {
  models: { analyst: "gpt-4o", debater: "gpt-4o", decision: "gpt-4o", risk: "gpt-4o" },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  llm_concurrency: 3,
  report_dir: "/tmp/test-reports",
};

function mockTradingPlan(): TradingPlan {
  return {
    direction: "Buy",
    target_price: 1400,
    stop_loss: 1200,
    position_pct: 30,
    execution_plan: "分两批建仓",
    entry_signals: ["价格回到1280"],
    exit_signals: ["跌破1200"],
    key_risks: ["政策变化"],
    t_plus_1_note: "T+1制度",
  };
}

function mockRiskDebateResponse(verdict: string) {
  return {
    choices: [{
      message: {
        content: `### 1. 立场声明
${verdict === "pass" ? "支持该交易计划" : verdict === "revise" ? "建议修订仓位" : "反对该交易计划"}

### 2. 证据支撑
- 证据1：估值处于合理区间
- 证据2：北向资金持续流入

### 3. 风险评估结论
- **verdict**：${verdict}
- **理由**：风险可控

<!-- VERDICT: {"direction": "${verdict}", "reason": "verdict: ${verdict}"} -->`,
      },
    }],
    usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
  };
}

describe("Risk Module", () => {
  let mockClient: OpenAI;
  let mockTraceLogger: any;

  beforeEach(() => {
    mockClient = {
      chat: { completions: { create: vi.fn() } },
    } as any;
    mockTraceLogger = { record: vi.fn(), count: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("runRiskDebate", () => {
    it("should run 3-way parallel risk debate", async () => {
      // Use mockImplementation to return verdicts based on role, not call order
      const mockCreate = vi.fn(async (params: any) => {
        const systemPrompt = params.messages?.[0]?.content || '';
        if (systemPrompt.includes('conse') || systemPrompt.includes('conservative')) {
          return mockRiskDebateResponse("revise");
        }
        return mockRiskDebateResponse("pass");
      });
      mockClient.chat.completions.create = mockCreate;

      const plan = mockTradingPlan();
      const reports = [{ role: "market", content: "Report", verdict: { direction: "看多", reason: "up" }, data_sources_used: ["kline"] }];

      const result = await runRiskDebate(plan, reports, mockConfig, mockClient, mockTraceLogger);

      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(result.risk_arguments).toHaveLength(3);
      expect(result.risk_arguments[0].role).toBe("aggressive");
      expect(result.risk_arguments[1].role).toBe("conservative");
      expect(result.risk_arguments[2].role).toBe("neutral");
      expect(result.risk_arguments[0].verdict).toBe("pass");
      expect(result.risk_arguments[1].verdict).toBe("revise");
    });
  });

  describe("runRiskManager", () => {
    it("should return pass assessment", async () => {
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: `### 1. 风险评分（0-100）
45

### 2. 风控决策
- **status**：pass
- **理由**：风险可控，交易计划可执行

<!-- VERDICT: {"direction": "pass", "reason": "风险可控"} -->`,
          },
        }],
        usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 },
      } as any);

      const debateResult: RiskDebateResult = {
        rounds: [[]],
        risk_arguments: [
          { role: "aggressive", position: "support", evidence: ["ev1"], verdict: "pass" },
          { role: "conservative", position: "revise", evidence: ["ev2"], verdict: "revise" },
          { role: "neutral", position: "support", evidence: ["ev3"], verdict: "pass" },
        ],
        total_tokens: 2100,
        total_cost_usd: 0.005,
      };

      const result = await runRiskManager(debateResult, mockTradingPlan(), mockConfig, mockClient, mockTraceLogger);

      expect(result.status).toBe("pass");
      expect(result.risk_score).toBe(45);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });
});
