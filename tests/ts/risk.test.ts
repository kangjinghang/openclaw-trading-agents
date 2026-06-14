import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runRiskDebate, runRiskManager, parseRiskJudge, extractPositionCap, parseRiskArgument, RISK_ROLES } from "../../src/risk";
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
    mockTraceLogger = { record: vi.fn(), count: 0, recordWarning: vi.fn() };
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

    it("should populate judge from RISK_JUDGE block and derive status from it", async () => {
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: `### 1. 风险评分（0-100）
62

### 2. 风控决策
- **status**：revise
- **理由**：仓位偏高，需降低并分批建仓

### 4. 约束清单
#### A. 硬约束
- 仓位 ≤ 30%
- 止损价 ≥ 60.5 元

#### B. 软建议
- 分两笔建仓

#### C. 进场前提
- 开盘不追高

#### D. 降风险触发器
- 跌破 60.5 减半仓

<!-- VERDICT: {"direction": "revise", "reason": "仓位偏高"} -->
<!-- RISK_JUDGE: {"verdict": "revise", "reason": "仓位偏高，需降低并分批建仓", "hard_constraints": ["仓位≤30%", "止损价≥60.5元"], "soft_constraints": ["分两笔建仓"], "execution_preconditions": ["开盘不追高"], "de_risk_triggers": ["跌破60.5减半仓"]} -->`,
          },
        }],
        usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 },
      } as any);

      const debateResult: RiskDebateResult = {
        rounds: [[]],
        risk_arguments: [],
        total_tokens: 0,
        total_cost_usd: 0,
      };

      const result = await runRiskManager(debateResult, mockTradingPlan(), mockConfig, mockClient, mockTraceLogger);

      // status derived from RISK_JUDGE.verdict (preferred over VERDICT)
      expect(result.status).toBe("revise");
      expect(result.judge).toBeDefined();
      expect(result.judge!.verdict).toBe("revise");
      expect(result.judge!.reason).toBe("仓位偏高，需降低并分批建仓");
      expect(result.judge!.hard_constraints).toEqual(["仓位≤30%", "止损价≥60.5元"]);
      expect(result.judge!.soft_constraints).toEqual(["分两笔建仓"]);
      expect(result.judge!.execution_preconditions).toEqual(["开盘不追高"]);
      expect(result.judge!.de_risk_triggers).toEqual(["跌破60.5减半仓"]);
      // risk_score still extracted via the separate risk-score regex
      expect(result.risk_score).toBe(62);
      // reasoning prefers judge.reason when present
      expect(result.reasoning).toBe("仓位偏高，需降低并分批建仓");
      // max_position_override extracted from hard_constraints "仓位≤30%"
      expect(result.max_position_override).toBe(30);
    });

    it("should use decision_deep model when set (deep-thinking tier for the gatekeeper)", async () => {
      const deepConfig: TradingAgentsConfig = {
        ...mockConfig,
        models: { ...mockConfig.models, decision_deep: "glm-4.6" },
      };
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      } as any);

      await runRiskManager(
        { rounds: [[]], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
        mockTradingPlan(),
        deepConfig,
        mockClient,
        mockTraceLogger
      );

      const callArgs = mockCreate.mock.calls[0][0] as any;
      expect(callArgs.model).toBe("glm-4.6");
    });

    it("should fall back to risk model when decision_deep is unset", async () => {
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      } as any);

      await runRiskManager(
        { rounds: [[]], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
        mockTradingPlan(),
        mockConfig,
        mockClient,
        mockTraceLogger
      );

      const callArgs = mockCreate.mock.calls[0][0] as any;
      expect(callArgs.model).toBe("gpt-4o"); // mockConfig.models.risk
    });

    it("records an error when status defaults to pass (RISK_JUDGE + VERDICT both missing)", async () => {
      // The scariest fallback: nothing parseable → status silently becomes
      // "pass", rubber-stamping the plan. A reviewer must see this.
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "风控经理输出但无任何结构化结论" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      } as any);

      await runRiskManager(
        { rounds: [[]], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
        mockTradingPlan(),
        mockConfig,
        mockClient,
        mockTraceLogger
      );

      const calls = mockTraceLogger.recordWarning.mock.calls.filter((c: any[]) => c[0].fn === "runRiskManager");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0][0]).toMatchObject({ phase: "risk", severity: "error" });
      expect(calls[0][0].detail).toContain("pass");
    });

    it("records a warn when hard_constraints exist but no position cap is extractable", async () => {
      // Risk gave constraints, but none matched the position-cap regex → cap
      // undefined → position_pct uncapped. This is the class that produced the
      // 600600 "judge says ≤10% but position stayed 15%" bug.
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: `### 1. 风险评分（0-100）
55

<!-- RISK_JUDGE: {"verdict": "pass", "reason": "ok", "hard_constraints": ["止损价≥60.5元", "开盘不追高"], "soft_constraints": [], "execution_preconditions": [], "de_risk_triggers": []} -->`,
          },
        }],
        usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 },
      } as any);

      await runRiskManager(
        { rounds: [[]], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
        mockTradingPlan(), // position_pct: 30, uncapped
        mockConfig,
        mockClient,
        mockTraceLogger
      );

      const calls = mockTraceLogger.recordWarning.mock.calls.filter((c: any[]) => c[0].fn === "extractPositionCap");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0][0]).toMatchObject({ phase: "risk", severity: "warn" });
    });

    it("does NOT warn on Sell direction (position_pct is clear ratio, not build ratio)", async () => {
      // 688662 real-run finding: Sell-side position_pct=100% means "clear 100%",
      // not "build 100%". extractPositionCap is irrelevant for sell-side, so the
      // "no cap extracted" warning is a false positive.
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: `### 1. 风险评分（0-100）
50

<!-- RISK_JUDGE: {"verdict": "pass", "reason": "ok", "hard_constraints": ["清仓比例100%不保留底仓", "首批60%必须在9:15-9:25集合竞价挂出", "跌破140元必须以跌停价挂单全部清仓"], "soft_constraints": [], "execution_preconditions": [], "de_risk_triggers": []} -->`,
          },
        }],
        usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 },
      } as any);

      const plan = mockTradingPlan();
      plan.direction = "Sell";
      plan.position_pct = 100;

      await runRiskManager(
        { rounds: [[]], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
        plan,
        mockConfig,
        mockClient,
        mockTraceLogger
      );

      const calls = mockTraceLogger.recordWarning.mock.calls.filter((c: any[]) => c[0].fn === "extractPositionCap");
      expect(calls.length).toBe(0);
    });

    it("does NOT warn on Underweight direction", async () => {
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: `### 1. 风险评分（0-100）
45

<!-- RISK_JUDGE: {"verdict": "pass", "reason": "ok", "hard_constraints": ["减仓至30%以下", "跌破支撑立即清仓"], "soft_constraints": [], "execution_preconditions": [], "de_risk_triggers": []} -->`,
          },
        }],
        usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 },
      } as any);

      const plan = mockTradingPlan();
      plan.direction = "Underweight";
      plan.position_pct = 70;  // reduce to 70%

      await runRiskManager(
        { rounds: [[]], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
        plan,
        mockConfig,
        mockClient,
        mockTraceLogger
      );

      const calls = mockTraceLogger.recordWarning.mock.calls.filter((c: any[]) => c[0].fn === "extractPositionCap");
      expect(calls.length).toBe(0);
    });
  });

  describe("runRiskDebate model routing", () => {
    it("should keep using the risk model (NOT decision_deep) for the 3-way risk debaters", async () => {
      const deepConfig: TradingAgentsConfig = {
        ...mockConfig,
        models: { ...mockConfig.models, decision_deep: "glm-4.6", risk: "gpt-4o" },
      };
      const calls: any[] = [];
      const mockCreate = vi.fn(async (params: any) => {
        calls.push(params);
        return mockRiskDebateResponse("pass");
      });
      mockClient.chat.completions.create = mockCreate;

      await runRiskDebate(mockTradingPlan(), [], deepConfig, mockClient, mockTraceLogger);

      expect(calls).toHaveLength(3);
      for (const c of calls) {
        expect(c.model).toBe("gpt-4o"); // risk debaters stay on the quick tier
      }
    });
  });
});

describe("parseRiskArgument", () => {
  it("should parse ## 二级标题格式（子标题+段落）", () => {
    const content = `## 1. 立场声明：**建议修订（REVISE）**

本风控评估认为，该交易计划存在结构性缺陷。要求修订后方可执行。

核心立场：**不是反对交易本身，而是反对以当前参数执行交易。**

## 2. 证据支撑

### 证据一：止损价5.50元低于跌停价5.54元——涨跌停板陷阱使止损形同虚设

这是本计划最致命的结构性缺陷。计划将止损设在5.50元，**低于跌停板价格5.54元**。

- **场景推演**：若股价跳空低开触及跌停，卖单无法成交
- **结论**：止损价必须高于跌停价

### 证据二：技术面全面看空

六维技术信号中，**看空证据4条 vs 超卖反弹证据2条**。

## 3. 风险评估结论

- **verdict**：revise
- **理由**：止损价必须高于跌停价

<!-- VERDICT: {"direction": "revise", "reason": "止损价5.50低于跌停价5.54"} -->`;

    const result = parseRiskArgument(content, "conservative");
    expect(result.position).toContain("建议修订");
    expect(result.position).toContain("不是反对交易本身");
    expect(result.evidence.length).toBe(2);
    expect(result.evidence[0]).toContain("止损价5.50元低于跌停价5.54元");
    expect(result.evidence[1]).toContain("技术面全面看空");
    expect(result.verdict).toBe("revise");
  });

  it("should parse ### 三级标题格式（兼容旧格式）", () => {
    const content = `### 1. 立场声明
支持该交易计划

### 2. 证据支撑
- 证据1：估值合理
- 证据2：资金流入

### 3. 风险评估结论
- **verdict**：pass
- **理由**：风险可控`;

    const result = parseRiskArgument(content, "aggressive");
    expect(result.position).toContain("支持");
    expect(result.evidence).toHaveLength(2);
    expect(result.verdict).toBe("pass");
  });

  it("should handle empty content gracefully", () => {
    const result = parseRiskArgument("", "neutral");
    expect(result.position).toBe("");
    expect(result.evidence).toHaveLength(0);
    expect(result.verdict).toBe("pass");
  });
});

describe("extractPositionCap", () => {
  it("extracts a 总仓位≤N% cap", () => {
    expect(extractPositionCap(["总仓位≤10%"])).toBe(10);
  });

  it("extracts a bare 仓位≤N% cap", () => {
    expect(extractPositionCap(["仓位≤30%"])).toBe(30);
  });

  it("extracts 仓位不超过 / 仓位最多 / 仓位上限 phrasings", () => {
    expect(extractPositionCap(["仓位不超过20%"])).toBe(20);
    expect(extractPositionCap(["仓位最多15%"])).toBe(15);
    expect(extractPositionCap(["仓位上限10%"])).toBe(10);
  });

  it("skips sub-batch constraints (首批/首笔/分批/加仓)", () => {
    // These are tranche caps, not total-position caps — must not be extracted.
    expect(extractPositionCap(["首批建仓≤5%"])).toBeUndefined();
    expect(extractPositionCap(["首笔仓位≤3%"])).toBeUndefined();
    expect(extractPositionCap(["分批建仓每批≤2%"])).toBeUndefined();
    expect(extractPositionCap(["加仓不超过5%"])).toBeUndefined();
  });

  it("returns the min (most restrictive) when multiple caps present", () => {
    expect(extractPositionCap(["总仓位≤15%", "总仓位≤10%"])).toBe(10);
  });

  it("returns undefined when no position constraint is present", () => {
    expect(extractPositionCap(["止损价≥58.90元严格执行", "跌破58.00元清仓", "建仓时间限定14:30-14:50"])).toBeUndefined();
  });

  it("returns undefined for empty or undefined input", () => {
    expect(extractPositionCap([])).toBeUndefined();
    expect(extractPositionCap(undefined)).toBeUndefined();
  });

  it("extracts 持仓 phrasings (持仓 is a 仓位 synonym in A-share trading)", () => {
    // Regression: 600600 real run emitted "最终持仓≤30%" but the 仓位-only
    // regex missed it, leaving max_position_override undefined. The cap only
    // held by coincidence (trader happened to pick the same number).
    expect(extractPositionCap(["最终持仓≤30%"])).toBe(30);
    expect(extractPositionCap(["持仓≤30%"])).toBe(30);
    expect(extractPositionCap(["总持仓≤20%"])).toBe(20);
    expect(extractPositionCap(["持仓不超过25%"])).toBe(25);
  });

  it("rejects absolute-quantity 持仓 constraints (no % → not a percentage cap)", () => {
    // 持仓量≤100万手 is open-interest, 持仓≤1000股 is share count — neither is
    // a position-% cap. The required % in the regex is what excludes these.
    expect(extractPositionCap(["持仓量≤100万手"])).toBeUndefined();
    expect(extractPositionCap(["持仓≤1000股"])).toBeUndefined();
  });

  it("requires a % sign (position caps are always percentages)", () => {
    // Without %, "仓位≤30" is ambiguous (30 what?) — not a clean cap to enforce.
    expect(extractPositionCap(["仓位≤30"])).toBeUndefined();
  });

  it("extracts 减仓比例≤总持仓N% phrasings (pattern 2)", () => {
    // Regression: 600507 real run emitted "减仓比例≤总持仓20%" — the original
    // regex only looked for 仓位/持仓 immediately before the operator.
    expect(extractPositionCap(["减仓比例≤总持仓20%"])).toBe(20);
    expect(extractPositionCap(["建仓规模≤总仓位30%"])).toBe(30);
    expect(extractPositionCap(["增仓比例不超过15%"])).toBe(15);
  });

  it("skips 单批/每批/单次 sub-batch constraints", () => {
    expect(extractPositionCap(["单批次减仓≤10%"])).toBeUndefined();
    expect(extractPositionCap(["每批建仓≤5%"])).toBeUndefined();
    expect(extractPositionCap(["单次加仓不超过3%"])).toBeUndefined();
  });
});

describe("parseRiskJudge", () => {
  it("should parse a valid RISK_JUDGE JSON block", () => {
    const content = `### 4. 约束清单

#### A. 硬约束
- 仓位 ≤ 30%

<!-- VERDICT: {"direction": "pass", "reason": "可控"} -->
<!-- RISK_JUDGE: {"verdict": "pass", "reason": "风险可控", "hard_constraints": ["仓位≤30%"], "soft_constraints": ["分两笔建仓"], "execution_preconditions": ["开盘不追高"], "de_risk_triggers": ["跌破60.5减半仓"]} -->`;

    const result = parseRiskJudge(content);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("pass");
    expect(result!.reason).toBe("风险可控");
    expect(result!.hard_constraints).toEqual(["仓位≤30%"]);
    expect(result!.soft_constraints).toEqual(["分两笔建仓"]);
    expect(result!.execution_preconditions).toEqual(["开盘不追高"]);
    expect(result!.de_risk_triggers).toEqual(["跌破60.5减半仓"]);
  });

  it("should return null for malformed JSON in RISK_JUDGE block", () => {
    const content = `Some markdown.

<!-- RISK_JUDGE: {invalid json, missing quotes} -->`;

    expect(parseRiskJudge(content)).toBeNull();
  });

  it("should return null when no RISK_JUDGE block is present", () => {
    const content = `### 风控决策
- **status**：pass

<!-- VERDICT: {"direction": "pass", "reason": "test"} -->`;

    expect(parseRiskJudge(content)).toBeNull();
  });

  it("should tolerate missing optional fields by defaulting to empty arrays / empty reason", () => {
    const content = `<!-- RISK_JUDGE: {"verdict": "revise"} -->`;

    const result = parseRiskJudge(content);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("revise");
    expect(result!.reason).toBe("");
    expect(result!.hard_constraints).toEqual([]);
    expect(result!.soft_constraints).toEqual([]);
    expect(result!.execution_preconditions).toEqual([]);
    expect(result!.de_risk_triggers).toEqual([]);
  });

  it("should return null when verdict is not one of pass/revise/reject", () => {
    const content = `<!-- RISK_JUDGE: {"verdict": "maybe", "reason": "x"} -->`;

    expect(parseRiskJudge(content)).toBeNull();
  });

  it("should return null when RISK_JUDGE JSON is not an object", () => {
    const content = `<!-- RISK_JUDGE: ["not", "an", "object"] -->`;

    expect(parseRiskJudge(content)).toBeNull();
  });
});

describe("RISK_ROLES framework richness", () => {
  const byRole = (role: string) =>
    RISK_ROLES.find((r) => r.role === role)!.instructions;

  it("exposes all three debate roles in order", () => {
    expect(RISK_ROLES.map((r) => r.role)).toEqual([
      "aggressive",
      "conservative",
      "neutral",
    ]);
  });

  it("aggressive argues the A-share bull case with concrete reframes (not a one-liner)", () => {
    const t = byRole("aggressive");
    expect(t.length).toBeGreaterThan(150);
    expect(t).toContain("政策底");
    expect(t).toContain("北向");
    expect(t).toContain("涨停");
    expect(t).toMatch(/50[-—]100x/); // PE-expansion reframe vs US 15-25x
  });

  it("conservative enumerates structural A-share risks with thresholds", () => {
    const t = byRole("conservative");
    expect(t.length).toBeGreaterThan(150);
    expect(t).toContain("T+1");
    expect(t).toContain("涨跌停");
    expect(t).toContain("解禁");
    expect(t).toContain("政策反转");
    expect(t).toMatch(/20%/); // 解禁 >20% threshold
    expect(t).toMatch(/PE>50x/);
  });

  it("neutral reframes risk around position sizing over direction", () => {
    const t = byRole("neutral");
    expect(t.length).toBeGreaterThan(150);
    expect(t).toContain("双刃剑"); // T+1 double-edged
    expect(t).toContain("仓位管理优先于方向"); // signature thesis
    expect(t).toMatch(/2[-—]4\s*周/); // rotation cycle
  });
});
