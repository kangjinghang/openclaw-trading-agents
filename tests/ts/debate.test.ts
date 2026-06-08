// tests/ts/debate.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runBullBearDebate, parseDebateState } from "../../src/debate";
import { TradingAgentsConfig, AnalystReport } from "../../src/types";
import OpenAI from "openai";

const mockConfig: TradingAgentsConfig = {
  models: { analyst: "gpt-4o", debater: "gpt-4o", decision: "gpt-4o", risk: "gpt-4o" },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  llm_concurrency: 3,
  report_dir: "/tmp/test-reports",
};

function mockAnalystReports(): AnalystReport[] {
  return [
    { role: "market", content: "Market analysis report", verdict: { direction: "看多", reason: "趋势向上" }, data_sources_used: ["kline"] },
    { role: "fundamentals", content: "Fundamentals report", verdict: { direction: "中性", reason: "估值合理" }, data_sources_used: ["fundamentals"] },
  ];
}

function mockDebateResponse(side: "bull" | "bear", round: number) {
  const prefix = side === "bull" ? "BULL" : "BEAR";
  const direction = side === "bull" ? "看多" : "看空";
  const summaryHeader = side === "bull" ? "论据" : "风险";
  return {
    choices: [{
      message: {
        content: `${side} debate round ${round}.

### ${side === "bull" ? "看多" : "看空"}论点

- **论点 ID**：${prefix}-${round}
- **核心观点**：Test claim ${round}
- **支撑证据**：Test evidence
- **信心水平**：中

### ${summaryHeader}总结
Test summary for ${side} round ${round}.

<!-- VERDICT: {"direction": "${direction}", "reason": "Test ${side} reason"} -->`,
      },
    }],
    usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 },
  };
}

describe("runBullBearDebate", () => {
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

  it("should run 2-round Bull<->Bear debate", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    mockCreate.mockResolvedValueOnce(mockDebateResponse("bull", 1) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse("bear", 1) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse("bull", 2) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse("bear", 2) as any);

    const reports = mockAnalystReports();
    const result = await runBullBearDebate(reports, "", mockConfig, mockClient, mockTraceLogger);

    expect(mockCreate).toHaveBeenCalledTimes(4);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].round).toBe(1);
    expect(result.rounds[1].round).toBe(2);
    expect(result.bull_summary).toContain("Test summary for bull");
    expect(result.bear_summary).toContain("Test summary for bear");
    expect(result.total_tokens).toBe(3600);
    expect(result.total_cost_usd).toBeGreaterThan(0);
  });

  it("should pass opponent claims to each subsequent turn", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    mockCreate.mockResolvedValueOnce(mockDebateResponse("bull", 1) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse("bear", 1) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse("bull", 2) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse("bear", 2) as any);

    const reports = mockAnalystReports();
    await runBullBearDebate(reports, "", mockConfig, mockClient, mockTraceLogger);

    // Bear in round 1 should receive Bull's claims
    const bearR1Call = mockCreate.mock.calls[1];
    const bearR1Message = bearR1Call[0].messages.find((m: any) => m.role === "user").content;
    expect(bearR1Message).toContain("BULL-1");

    // Bull in round 2 should receive Bear's round 1 claims
    const bullR2Call = mockCreate.mock.calls[2];
    const bullR2Message = bullR2Call[0].messages.find((m: any) => m.role === "user").content;
    expect(bullR2Message).toContain("BEAR-1");
  });
});

describe("parseDebateState", () => {
  it("should parse a valid DEBATE_STATE JSON block", () => {
    const content = `### 看多论点

- **论点 ID**：BULL-1
- **核心观点**：盈利超预期

### 论据总结
多头核心逻辑成立。

<!-- DEBATE_STATE: {"responded_claim_ids": ["BEAR-1"], "new_claims": [{"claim": "盈利超预期", "evidence": ["Q3净利+30%", "毛利率提升"], "confidence": 0.8}], "resolved_claim_ids": ["BEAR-1"], "unresolved_claim_ids": [], "next_focus_claim_ids": ["BULL-1"], "round_summary": "多头反驳估值泡沫论点", "round_goal": "聚焦资金面"} -->`;

    const result = parseDebateState(content);
    expect(result).not.toBeNull();
    expect(result!.responded_claim_ids).toEqual(["BEAR-1"]);
    expect(result!.new_claims).toHaveLength(1);
    expect(result!.new_claims[0].claim).toBe("盈利超预期");
    expect(result!.new_claims[0].evidence).toEqual(["Q3净利+30%", "毛利率提升"]);
    expect(result!.new_claims[0].confidence).toBe(0.8);
    expect(result!.resolved_claim_ids).toEqual(["BEAR-1"]);
    expect(result!.unresolved_claim_ids).toEqual([]);
    expect(result!.next_focus_claim_ids).toEqual(["BULL-1"]);
    expect(result!.round_summary).toBe("多头反驳估值泡沫论点");
    expect(result!.round_goal).toBe("聚焦资金面");
  });

  it("should return null for malformed JSON in DEBATE_STATE block", () => {
    const content = `Some markdown.

<!-- DEBATE_STATE: {invalid json, missing quotes} -->`;

    expect(parseDebateState(content)).toBeNull();
  });

  it("should return null when no DEBATE_STATE block is present", () => {
    const content = `### 看多论点

- **论点 ID**：BULL-1
- **核心观点**：Test claim

<!-- VERDICT: {"direction": "看多", "reason": "test"} -->`;

    expect(parseDebateState(content)).toBeNull();
  });

  it("should tolerate missing optional fields by defaulting to empty", () => {
    const content = `<!-- DEBATE_STATE: {"new_claims": [{"claim": "only claim", "evidence": ["e1"], "confidence": 0.5}]} -->`;

    const result = parseDebateState(content);
    expect(result).not.toBeNull();
    expect(result!.new_claims).toHaveLength(1);
    expect(result!.responded_claim_ids).toEqual([]);
    expect(result!.resolved_claim_ids).toEqual([]);
    expect(result!.unresolved_claim_ids).toEqual([]);
    expect(result!.next_focus_claim_ids).toEqual([]);
    expect(result!.round_summary).toBe("");
    expect(result!.round_goal).toBe("");
  });

  it("should return null when DEBATE_STATE JSON is not an object", () => {
    const content = `<!-- DEBATE_STATE: ["not", "an", "object"] -->`;

    expect(parseDebateState(content)).toBeNull();
  });
});

// Build a mock LLM response carrying both VERDICT and DEBATE_STATE blocks.
function mockStatefulResponse(
  side: "bull" | "bear",
  markdownId: string,
  topic: string,
  evidence: string,
  confidenceWord: "高" | "中" | "低",
  state: object
) {
  const direction = side === "bull" ? "看多" : "看空";
  const claimHeader = side === "bull" ? "看多论点" : "看空论点";
  const summaryHeader = side === "bull" ? "论据" : "风险";
  return {
    choices: [{
      message: {
        content: `### ${claimHeader}

- **论点 ID**：${markdownId}
- **核心观点**：${topic}
- **支撑证据**：${evidence}
- **信心水平**：${confidenceWord}

### ${summaryHeader}总结
${side} stateful summary.

<!-- VERDICT: {"direction": "${direction}", "reason": "${side} stateful"} -->
<!-- DEBATE_STATE: ${JSON.stringify(state)} -->`,
      },
    }],
    usage: { prompt_tokens: 500, completion_tokens: 250, total_tokens: 750 },
  };
}

describe("runBullBearDebate state-machine (DEBATE_STATE path)", () => {
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

  it("should assign counter-based IDs, propagate resolved/unresolved status, and inject focus", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // Round 1 Bull: introduces BULL-1 (盈利超预期)
    mockCreate.mockResolvedValueOnce(mockStatefulResponse(
      "bull", "BULL-1", "盈利超预期", "Q3净利+30%", "高",
      {
        responded_claim_ids: [],
        new_claims: [{ claim: "盈利超预期", evidence: ["Q3净利+30%"], confidence: 0.8 }],
        resolved_claim_ids: [],
        unresolved_claim_ids: [],
        next_focus_claim_ids: [],
        round_summary: "多头展开盈利论点",
        round_goal: "空头需回应盈利超预期",
      }
    ) as any);

    // Round 1 Bear: responds to BULL-1, introduces BEAR-1, marks BULL-1 unresolved
    mockCreate.mockResolvedValueOnce(mockStatefulResponse(
      "bear", "BEAR-1", "估值过高", "PE 60x", "中",
      {
        responded_claim_ids: ["BULL-1"],
        new_claims: [{ claim: "估值过高", evidence: ["PE 60x"], confidence: 0.7 }],
        resolved_claim_ids: [],
        unresolved_claim_ids: ["BULL-1"],
        next_focus_claim_ids: ["BULL-1"],
        round_summary: "空头质疑估值",
        round_goal: "多头需证明成长性匹配估值",
      }
    ) as any);

    // Round 2 Bull: receives focus [BULL-1], responds to BEAR-1, resolves it, introduces BULL-2
    mockCreate.mockResolvedValueOnce(mockStatefulResponse(
      "bull", "BULL-2", "成长股估值合理", "PEG 1.2", "中",
      {
        responded_claim_ids: ["BEAR-1"],
        new_claims: [{ claim: "成长股估值合理", evidence: ["PEG 1.2"], confidence: 0.75 }],
        resolved_claim_ids: ["BEAR-1"],
        unresolved_claim_ids: [],
        next_focus_claim_ids: [],
        round_summary: "多头以PEG反驳估值",
        round_goal: "空头需证明PEG失真",
      }
    ) as any);

    // Round 2 Bear: introduces BEAR-2, marks BULL-2 unresolved
    mockCreate.mockResolvedValueOnce(mockStatefulResponse(
      "bear", "BEAR-2", "行业增速放缓", "订单-15%", "中",
      {
        responded_claim_ids: ["BULL-2"],
        new_claims: [{ claim: "行业增速放缓", evidence: ["订单-15%"], confidence: 0.65 }],
        resolved_claim_ids: [],
        unresolved_claim_ids: ["BULL-2"],
        next_focus_claim_ids: ["BULL-2"],
        round_summary: "空头转向行业增速",
        round_goal: "聚焦需求侧",
      }
    ) as any);

    const reports = mockAnalystReports();
    const result = await runBullBearDebate(reports, "", mockConfig, mockClient, mockTraceLogger);

    expect(mockCreate).toHaveBeenCalledTimes(4);
    expect(result.rounds).toHaveLength(2);

    // ── Counter-based IDs (override LLM markdown IDs, never reset across rounds) ──
    expect(result.rounds[0].bull_claims[0].id).toBe("BULL-1");
    expect(result.rounds[0].bear_claims[0].id).toBe("BEAR-1");
    expect(result.rounds[1].bull_claims[0].id).toBe("BULL-2");
    expect(result.rounds[1].bear_claims[0].id).toBe("BEAR-2");

    // ── Status propagation (claims are mutated in-place via the registry) ──
    expect(result.rounds[0].bull_claims[0].status).toBe("unresolved"); // BULL-1
    expect(result.rounds[0].bear_claims[0].status).toBe("resolved");   // BEAR-1
    expect(result.rounds[1].bull_claims[0].status).toBe("unresolved"); // BULL-2
    expect(result.rounds[1].bear_claims[0].status).toBe("open");       // BEAR-2 (never responded to)

    // ── Round-level state fields ──
    expect(result.rounds[0].bear_responded_ids).toEqual(["BULL-1"]);
    expect(result.rounds[0].unresolved_ids).toEqual(["BULL-1"]);
    expect(result.rounds[0].next_focus_ids).toEqual(["BULL-1"]);
    expect(result.rounds[0].round_summary).toBe("空头质疑估值");
    expect(result.rounds[0].round_goal).toBe("多头需证明成长性匹配估值");

    expect(result.rounds[1].bull_responded_ids).toEqual(["BEAR-1"]);
    expect(result.rounds[1].resolved_ids).toEqual(["BEAR-1"]);
    // unresolved_ids is cumulative across rounds: BULL-1 (from round 1, never resolved)
    // plus BULL-2 (newly marked unresolved by round 2 bear)
    expect(result.rounds[1].unresolved_ids).toEqual(expect.arrayContaining(["BULL-1", "BULL-2"]));
    expect(result.rounds[1].unresolved_ids).toHaveLength(2);

    // ── Focus propagation: round 2 bull should have received BULL-1 as a focus claim ──
    const bullR2Call = mockCreate.mock.calls[2];
    const bullR2Message = bullR2Call[0].messages.find((m: any) => m.role === "user").content;
    expect(bullR2Message).toContain("BULL-1");
    expect(bullR2Message).toContain("本轮必须回应的焦点 claim");

    // Bear in round 1 should still see Bull's claims via opponent_claims (backward compat)
    const bearR1Call = mockCreate.mock.calls[1];
    const bearR1Message = bearR1Call[0].messages.find((m: any) => m.role === "user").content;
    expect(bearR1Message).toContain("BULL-1");
  });
});
