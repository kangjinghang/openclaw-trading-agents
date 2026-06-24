import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runTrader, parseTraderPlan, parsePositionPct, parsePositionPctSource } from "../../src/trader";
import { loadAndRender } from "../../src/prompt-loader";
import {
  TradingAgentsConfig,
  AnalystReport,
  ResearchDecision,
  RiskJudge,
} from "../../src/types";
import OpenAI from "openai";
import { LLM_DEFAULT_MAX_TOKENS } from "../../src/constants";

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
    mockTraceLogger = { record: vi.fn(), count: 0, recordWarning: vi.fn() };
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
    // 引用常量而非硬编码，避免 LLM_DEFAULT_MAX_TOKENS 调整时再次脱节
    expect(callArgs.max_tokens).toBe(LLM_DEFAULT_MAX_TOKENS);
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

  it("should parse 失效条件 section into invalidations", async () => {
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
1. 价格回调到 1280
2. 北向资金净流入

### 退出信号
1. 跌破 1200

### 失效条件
1. 重新放量突破压力位
2. 基本面逻辑被证伪

### T+1 操作约束说明
分两日建仓。

### 关键风险提示
1. 政策变化风险

<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->`,
          },
        },
      ],
      usage: { prompt_tokens: 800, completion_tokens: 250, total_tokens: 1050 },
    } as any);

    const result = await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.invalidations).toEqual([
      "重新放量突破压力位",
      "基本面逻辑被证伪",
    ]);
  });

  it("should default invalidations to empty array when section is absent", async () => {
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
1. 信号 A

### 退出信号
1. 信号 B

### T+1 操作约束说明
T+1.

### 关键风险提示
1. 风险 A

<!-- VERDICT: {"direction": "Buy", "reason": "test"} -->`,
          },
        },
      ],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
    } as any);

    const result = await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.invalidations).toEqual([]);
  });

  it("should parse TRADER_PLAN block into structured signals (real LLM format: numbered headings + tables)", async () => {
    // This mirrors actual LLM output: sections numbered per the prompt
    // ("### 3. 入场信号（triggers — …）") with markdown TABLE bodies —
    // a format parseListSection cannot parse. The TRADER_PLAN JSON block
    // is the reliable path.
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: `### 1. 交易方向与仓位
- **建议方向**：买入
- **建议仓位**：30%

### 2. 价格区间
- **目标价格**：1400 元
- **止损价格**：1200 元

### 3. 入场信号（triggers — 等什么信号才动手）

| # | 信号条件 | 触发动作 |
|---|----------|----------|
| **1** | 放量突破5.35元 | 加仓 |
| **2** | MACD零轴下方金叉 | 加仓 |

### 4. 退出信号

| # | 信号条件 |
|---|----------|
| **1** | 收盘价连续2日低于4.98元 |

### 5. 失效条件（invalidations — 出现即推翻判断）

| # | 失效条件 |
|---|----------|
| **1** | 半年报净利润环比下降>30% |

### 7. 关键风险提示

| # | 风险因素 |
|---|----------|
| **1** | 北向资金持续流出 |

<!-- TRADER_PLAN: {"entry_signals": ["放量突破5.35元", "MACD零轴下方金叉"], "exit_signals": ["收盘价连续2日低于4.98元"], "invalidations": ["半年报净利润环比下降>30%"], "key_risks": ["北向资金持续流出"]} -->

<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->`,
          },
        },
      ],
      usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 },
    } as any);

    const result = await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.entry_signals).toEqual([
      "放量突破5.35元",
      "MACD零轴下方金叉",
    ]);
    expect(result.exit_signals).toEqual(["收盘价连续2日低于4.98元"]);
    expect(result.invalidations).toEqual(["半年报净利润环比下降>30%"]);
    expect(result.key_risks).toEqual(["北向资金持续流出"]);
  });

  it("should fall back to parseListSection when TRADER_PLAN block is absent (numbered headings + list items)", async () => {
    // No TRADER_PLAN block → must fall back to parseListSection, which now
    // tolerates the "### 3. 入场信号（…）" numbered-heading format.
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

### 3. 入场信号（triggers — 等什么信号才动手）
1. 放量突破5.35元
2. MACD金叉

### 5. 失效条件（invalidations — 出现即推翻判断）
1. 半年报环比下降30%

### T+1 操作约束说明
T+1.

### 关键风险提示
1. 北向流出

<!-- VERDICT: {"direction": "Buy", "reason": "test"} -->`,
          },
        },
      ],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
    } as any);

    const result = await runTrader(
      mockResearchDecision(),
      [],
      "",
      mockConfig,
      mockClient,
      mockTraceLogger
    );

    expect(result.entry_signals).toEqual(["放量突破5.35元", "MACD金叉"]);
    expect(result.invalidations).toEqual(["半年报环比下降30%"]);
  });

  it("records a warn when position_pct falls back to a synonym (建议仓位 absent)", async () => {
    // The 600600 regression: a Sell plan phrased the total as 减仓总量 with no
    // 建议仓位 line. The synonym fallback recovers the value, but a reviewer
    // must see the run degraded to the synonym path.
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: { content: `### 1. 交易方向与仓位
| **减仓总量** | 不超过总资金的 **30%** |
### 价格区间
- **目标价格**：900 元
- **止损价格**：1100 元
<!-- VERDICT: {"direction": "Sell", "reason": "减仓"} -->` },
      }],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
    } as any);

    await runTrader({ ...mockResearchDecision(), direction: "Underweight" }, [], "", mockConfig, mockClient, mockTraceLogger);

    const posCalls = mockTraceLogger.recordWarning.mock.calls.filter((c: any[]) => c[0].fn === "parsePositionPct");
    expect(posCalls.length).toBeGreaterThanOrEqual(1);
    expect(posCalls[0][0]).toMatchObject({ phase: "trader", severity: "warn" });
    expect(posCalls[0][0].detail).toContain("减仓总量");
  });

  it("records an error when position_pct is 0 on a non-Hold plan", async () => {
    // No position label at all → position_pct=0, which silently defeats the
    // downstream cap-binding. This is the dangerous case (error severity).
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: { content: `### 交易方向与仓位
- **建议方向**：买入
### 价格区间
- **目标价格**：900 元
- **止损价格**：850 元
<!-- VERDICT: {"direction": "Buy", "reason": "建仓"} -->` },
      }],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
    } as any);

    await runTrader(mockResearchDecision(), [], "", mockConfig, mockClient, mockTraceLogger);

    const posCalls = mockTraceLogger.recordWarning.mock.calls.filter((c: any[]) => c[0].fn === "parsePositionPct");
    expect(posCalls.length).toBeGreaterThanOrEqual(1);
    expect(posCalls[0][0]).toMatchObject({ phase: "trader", severity: "error" });
    expect(posCalls[0][0].detail).toContain("0");
  });

  it("does NOT warn about position on a Hold plan (0% is legitimate)", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: { content: `### 交易方向与仓位
- **建议仓位**：0%
### 价格区间
- **目标价格**：1000 元
- **止损价格**：950 元
<!-- VERDICT: {"direction": "Hold", "reason": "观望"} -->` },
      }],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
    } as any);

    await runTrader({ ...mockResearchDecision(), direction: "Hold" }, [], "", mockConfig, mockClient, mockTraceLogger);

    const posCalls = mockTraceLogger.recordWarning.mock.calls.filter((c: any[]) => c[0].fn === "parsePositionPct");
    expect(posCalls).toHaveLength(0);
  });

  it("records a warn when target_price/stop_loss parse to 0 on a non-Hold plan", async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: { content: `### 交易方向与仓位
- **建议仓位**：20%
### 价格区间
- 未指定目标价
- 未指定止损价
<!-- VERDICT: {"direction": "Buy", "reason": "test"} -->` },
      }],
      usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
    } as any);

    await runTrader(mockResearchDecision(), [], "", mockConfig, mockClient, mockTraceLogger);

    const numericCalls = mockTraceLogger.recordWarning.mock.calls.filter((c: any[]) => c[0].fn === "parseNumericField");
    expect(numericCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("parseTraderPlan", () => {
  it("parses a complete TRADER_PLAN block", () => {
    const content = `some prose

<!-- TRADER_PLAN: {"entry_signals": ["放量突破5.35", "MACD金叉"], "exit_signals": ["跌破4.98"], "invalidations": ["半年报环比-30%"], "key_risks": ["北向流出"]} -->
trailing text`;
    const plan = parseTraderPlan(content);
    expect(plan).not.toBeNull();
    expect(plan!.entry_signals).toEqual(["放量突破5.35", "MACD金叉"]);
    expect(plan!.exit_signals).toEqual(["跌破4.98"]);
    expect(plan!.invalidations).toEqual(["半年报环比-30%"]);
    expect(plan!.key_risks).toEqual(["北向流出"]);
  });

  it("returns null when no block is present", () => {
    expect(parseTraderPlan("no block here")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseTraderPlan("<!-- TRADER_PLAN: {bad json} -->")).toBeNull();
  });

  it("returns null on a non-object payload", () => {
    expect(parseTraderPlan('<!-- TRADER_PLAN: ["not", "object"] -->')).toBeNull();
  });

  it("coerces missing arrays to empty defaults (partial output)", () => {
    const plan = parseTraderPlan(
      '<!-- TRADER_PLAN: {"entry_signals": ["信号A"]} -->'
    );
    expect(plan).not.toBeNull();
    expect(plan!.entry_signals).toEqual(["信号A"]);
    expect(plan!.exit_signals).toEqual([]);
    expect(plan!.invalidations).toEqual([]);
    expect(plan!.key_risks).toEqual([]);
  });

  it("filters non-string entries from arrays", () => {
    const plan = parseTraderPlan(
      '<!-- TRADER_PLAN: {"entry_signals": ["ok", 123, true, "ok2"]} -->'
    );
    expect(plan!.entry_signals).toEqual(["ok", "ok2"]);
  });
});

describe("parsePositionPct", () => {
  it("returns the canonical 建议仓位 value when the label is present", () => {
    const content = `### 交易方向与仓位
- **建议仓位**：30%
`;
    expect(parsePositionPct(content)).toBe(30);
  });

  it("keeps an explicit 0% (Hold) — does not fall back to a synonym", () => {
    // A Hold plan may legitimately say 建议仓位 0% ("flat / no new position").
    // The label IS present, so 0 must stand even if a synonym appears nearby.
    const content = `### 交易方向与仓位
- **建议仓位**：0%
### T+1
维持现有仓位，总仓位约 20%。
`;
    expect(parsePositionPct(content)).toBe(0);
  });

  it("falls back to 减仓总量 when 建议仓位 is absent (real 600600 Sell output)", () => {
    // Verbatim shape from the 600600 trace: a Sell plan phrased the total as
    // "减仓总量 ... 30%" in a table cell, with NO 建议仓位 line. Previously
    // this parsed as position_pct=0.
    const content = `### 1. 交易方向与仓位
| **建议方向** | **卖出（Underweight）** — 与研究经理决策一致 |
| **减仓总量** | 不超过总资金的 **30%** |
| **建仓方式** | 分 **2 批**执行，比例 **60:40** |
`;
    expect(parsePositionPct(content)).toBe(30);
  });

  it("falls back to the 减仓比例 synonym", () => {
    const content = `### 交易方向与仓位
- **减仓比例**：不超过 25%
`;
    expect(parsePositionPct(content)).toBe(25);
  });

  it("falls back to the 总仓位 synonym", () => {
    const content = `### 交易方向与仓位
- **总仓位**：上限 40%
`;
    expect(parsePositionPct(content)).toBe(40);
  });

  it("returns 0 when no position label is present anywhere", () => {
    const content = `### 交易方向与仓位
- **建议方向**：买入
### 价格区间
- **目标价格**：1300 元
`;
    expect(parsePositionPct(content)).toBe(0);
  });

  it("never mistakes a sub-batch tranche for the total", () => {
    // Only a per-tranche label is present (no total-position synonym). Must
    // return 0 rather than grabbing the tranche's 18%.
    const content = `### 交易方向与仓位
- **建议方向**：卖出
- **第一批**：总资金的 18%
- **第二批**：总资金的 12%
`;
    expect(parsePositionPct(content)).toBe(0);
  });

  it("prefers the total over a sub-batch tranche when both are present", () => {
    const content = `### 1. 交易方向与仓位
| **减仓总量** | 不超过总资金的 **30%** |
| **第一批** | 总资金的 **18%** |
| **第二批** | 总资金的 **12%** |
`;
    expect(parsePositionPct(content)).toBe(30);
  });
});
