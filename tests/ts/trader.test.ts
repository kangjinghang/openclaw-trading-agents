import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runTrader } from "../../src/trader";
import { loadAndRender } from "../../src/prompt-loader";
import {
  TradingAgentsConfig,
  AnalystReport,
  ResearchDecision,
  RiskJudge,
} from "../../src/types";
import OpenAI from "openai";

// Mock prompt-loader to avoid disk I/O in unit tests
vi.mock("../../src/prompt-loader", () => ({
  loadAndRender: vi.fn(() => "mocked prompt content"),
}));

const mockConfig: TradingAgentsConfig = {
  models: {
    analyst: "gpt-4o",
    debater: "gpt-4o",
    decision: "gpt-4o",
    risk: "gpt-4o",
  },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  llm_concurrency: 3,
  report_dir: "/tmp/test-reports",
};

function mockResearchDecision(): ResearchDecision {
  return {
    direction: "Overweight",
    confidence: 0.72,
    bull_score: 75,
    bear_score: 45,
    reasoning: "多头论据更充分",
    key_debate_points: ["政策利好"],
    verdict: { direction: "Overweight", reason: "多头论据更充分" },
  };
}

describe("runTrader", () => {
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

  it("should generate trading plan from research decision", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 交易方向与仓位
- **建议方向**：买入
- **建议仓位**：30%
- **建仓方式**：分两批，第一批 60%，第二批 40%

### 价格区间
- **目标价格**：1400 元
- **止损价格**：1200 元
- **入场价格区间**：1260 - 1300 元

### 入场信号
1. 价格回调到1280
2. 北向资金净流入

### 退出信号
1. 跌破1200
2. MACD死叉

### T+1 操作约束说明
当日买入后次日才能卖出，建议分两日建仓。

### 关键风险提示
1. 政策变化风险
2. 市场系统性风险

<!-- VERDICT: {"direction": "Buy", "reason": "建议分批建仓"} -->`,
          },
        },
      ],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 400,
        total_tokens: 1200,
      },
    } as any);

    const reports: AnalystReport[] = [
      {
        role: "market",
        content: "Market report",
        verdict: { direction: "看多", reason: "up" },
        data_sources_used: ["kline"],
      },
    ];
    const decision = mockResearchDecision();

    const result = await runTrader(
      decision,
      reports,
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.target_price).toBe(1400);
    expect(result.stop_loss).toBe(1200);
    expect(result.position_pct).toBe(30);
    expect(result.entry_signals.length).toBeGreaterThan(0);
    expect(result.exit_signals.length).toBeGreaterThan(0);
    expect(result.t_plus_1_note).toContain("次日才能卖出");
    expect(result.direction).toBe("Buy"); // Overweight maps to Buy
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("should map Underweight direction to Sell", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 交易方向与仓位
- **建议仓位**：20%

### 价格区间
- **目标价格**：900 元
- **止损价格**：1100 元

### 入场信号
1. 反弹信号

### 退出信号
1. 止损触发

### T+1 操作约束说明
减仓分两日完成。

### 关键风险提示
1. 下行风险

<!-- VERDICT: {"direction": "Sell", "reason": "减仓"} -->`,
          },
        },
      ],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 200,
        total_tokens: 1000,
      },
    } as any);

    const decision: ResearchDecision = {
      ...mockResearchDecision(),
      direction: "Underweight",
    };

    const result = await runTrader(
      decision,
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.direction).toBe("Sell");
  });

  it("should keep Hold direction unchanged", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 交易方向与仓位
- **建议仓位**：0%

### 价格区间
- **目标价格**：1300 元
- **止损价格**：1150 元

### 入场信号
1. 观望信号

### 退出信号
1. 无

### T+1 操作约束说明
维持现有仓位。

### 关键风险提示
1. 震荡风险

<!-- VERDICT: {"direction": "Hold", "reason": "观望"} -->`,
          },
        },
      ],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 200,
        total_tokens: 1000,
      },
    } as any);

    const decision: ResearchDecision = {
      ...mockResearchDecision(),
      direction: "Hold",
    };

    const result = await runTrader(
      decision,
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.direction).toBe("Hold");
  });

  it("should use default T+1 note when section is missing", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 交易方向与仓位
- **建议仓位**：10%

### 价格区间
- **目标价格**：1300 元
- **止损价格**：1200 元

### 入场信号
1. 信号A

### 退出信号
1. 信号B

### 关键风险提示
1. 风险A

<!-- VERDICT: {"direction": "Buy", "reason": "谨慎建仓"} -->`,
          },
        },
      ],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 200,
        total_tokens: 1000,
      },
    } as any);

    const result = await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.t_plus_1_note).toBe("T+1 制度：当日买入次日才能卖出");
  });

  it("should handle missing numeric fields with defaults", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 交易方向与仓位
- **建议方向**：买入

### 价格区间
- No target price specified
- No stop loss specified

### 入场信号
1. Some signal

### 退出信号
1. Some exit

### T+1 操作约束说明
Standard T+1.

### 关键风险提示
1. General risk

<!-- VERDICT: {"direction": "Buy", "reason": "test"} -->`,
          },
        },
      ],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 200,
        total_tokens: 1000,
      },
    } as any);

    const result = await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.target_price).toBe(0);
    expect(result.stop_loss).toBe(0);
    expect(result.position_pct).toBe(0);
  });

  it("should pass correct LLM call options", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 交易方向与仓位
- **建议仓位**：10%

### 价格区间
- **目标价格**：1300 元
- **止损价格**：1200 元

### 入场信号
1. Signal A

### 退出信号
1. Signal B

### T+1 操作约束说明
Standard.

### 关键风险提示
1. Risk A

<!-- VERDICT: {"direction": "Buy", "reason": "test"} -->`,
          },
        },
      ],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 200,
        total_tokens: 1000,
      },
    } as any);

    await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs.model).toBe("gpt-4o");
    expect(callArgs.temperature).toBe(0.3);
    expect(callArgs.max_tokens).toBe(16000);
    expect(callArgs.messages[0].content).toContain(
      "A-share trader creating specific execution plans"
    );
  });

  it("should inject risk_judge constraints into the prompt when riskJudge is passed", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 交易方向与仓位
- **建议仓位**：20%

### 价格区间
- **目标价格**：1300 元
- **止损价格**：1200 元

### 入场信号
1. 信号A

### 退出信号
1. 信号B

### T+1 操作约束说明
T+1.

### 关键风险提示
1. 风险A

<!-- VERDICT: {"direction": "Buy", "reason": "test"} -->`,
          },
        },
      ],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
    } as any);

    const riskJudge: RiskJudge = {
      verdict: "revise",
      reason: "仓位偏高",
      hard_constraints: ["仓位≤30%", "止损价≥60.5元"],
      soft_constraints: ["分两笔建仓"],
      execution_preconditions: ["开盘不追高"],
      de_risk_triggers: ["跌破60.5减半仓"],
    };

    await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger,
      undefined,
      undefined,
      riskJudge
    );

    expect(loadAndRender).toHaveBeenCalledTimes(1);
    const renderArgs = vi.mocked(loadAndRender).mock.calls[0];
    const vars = renderArgs[1] as Record<string, string>;
    // All four constraint types should be present in the rendered prompt
    expect(vars.risk_judge).toContain("仓位≤30%");
    expect(vars.risk_judge).toContain("止损价≥60.5元");
    expect(vars.risk_judge).toContain("分两笔建仓");
    expect(vars.risk_judge).toContain("开盘不追高");
    expect(vars.risk_judge).toContain("跌破60.5减半仓");
  });

  it("should pass an empty risk_judge string when riskJudge is not provided", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 交易方向与仓位
- **建议仓位**：10%

### 价格区间
- **目标价格**：1300 元
- **止损价格**：1200 元

### 入场信号
1. 信号A

### 退出信号
1. 信号B

### T+1 操作约束说明
T+1.

### 关键风险提示
1. 风险A

<!-- VERDICT: {"direction": "Buy", "reason": "test"} -->`,
          },
        },
      ],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
    } as any);

    await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    const renderArgs = vi.mocked(loadAndRender).mock.calls[0];
    const vars = renderArgs[1] as Record<string, string>;
    expect(vars.risk_judge).toBe("");
  });
});
