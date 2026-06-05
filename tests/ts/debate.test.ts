// tests/ts/debate.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runBullBearDebate } from "../../src/debate";
import { TradingAgentsConfig, AnalystReport } from "../../src/types";
import OpenAI from "openai";

const mockConfig: TradingAgentsConfig = {
  models: { analyst: "gpt-4o", debater: "gpt-4o", decision: "gpt-4o", risk: "gpt-4o" },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
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
    const result = await runBullBearDebate(reports, mockConfig, mockClient, mockTraceLogger);

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
    await runBullBearDebate(reports, mockConfig, mockClient, mockTraceLogger);

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
