# Phase 3: Bull↔Bear Debate Mechanism — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-round Bull↔Bear debate layer and three-way risk debate on top of the 7-analyst parallel pipeline, producing higher-quality trading decisions through adversarial reasoning.

**Architecture:** Sequential stage functions chained by `runFullAnalysis()`. Each stage (debate, research manager, trader, risk) lives in its own file with its own test. Quick mode stays unchanged.

**Tech Stack:** TypeScript (strict, ES2020, CommonJS), OpenAI-compatible API, Vitest.

---

## File Structure

### New files (created by this plan)

| File | Responsibility |
|------|---------------|
| `src/debate.ts` | `runBullBearDebate()` — multi-round Bull↔Bear |
| `src/research-manager.ts` | `runResearchManager()` — debate scoring |
| `src/trader.ts` | `runTrader()` — execution planning |
| `src/risk.ts` | `runRiskDebate()` + `runRiskManager()` — risk gate |
| `skills/trading-analysis/prompts/debate/bull_researcher.md` | Bull debater prompt |
| `skills/trading-analysis/prompts/debate/bear_researcher.md` | Bear debater prompt |
| `skills/trading-analysis/prompts/debate/research_manager.md` | Debate scorer prompt |
| `skills/trading-analysis/prompts/debate/trader.md` | Execution plan prompt |
| `skills/trading-analysis/prompts/debate/risk_debater.md` | 3-way risk debater prompt |
| `skills/trading-analysis/prompts/debate/risk_manager.md` | Risk manager prompt |
| `tests/ts/debate.test.ts` | Debate unit tests |
| `tests/ts/research_manager.test.ts` | Research manager unit tests |
| `tests/ts/trader.test.ts` | Trader unit tests |
| `tests/ts/risk.test.ts` | Risk debate + manager unit tests |

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | Add DebateClaim, DebateRound, DebateResult, ResearchDecision, TradingPlan, RiskArgument, RiskDebateResult, RiskAssessment, FullAnalysisResult |
| `src/orchestrator.ts` | Extract `runAnalystPhase()`, add `runFullAnalysis()` |
| `src/index.ts` | Register `trading_full` tool |
| `src/report-store.ts` | Add `saveFull()` method |
| `tests/ts/integration.test.ts` | Add full analysis integration test |

---

### Task 1: Add Phase 3 Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add new types to `src/types.ts`**

Append after the existing `ScriptResult` interface (line 110):

```typescript
// ── Phase 3: Debate types ──

/** A single debate claim with structured evidence. */
export interface DebateClaim {
  id: string;
  side: "bull" | "bear";
  topic: string;
  evidence: string;
  confidence: number;
  responded_by?: string;
}

/** One round of Bull↔Bear debate. */
export interface DebateRound {
  round: number;
  bull_claims: DebateClaim[];
  bear_claims: DebateClaim[];
}

/** Full Bull↔Bear debate result. */
export interface DebateResult {
  rounds: DebateRound[];
  bull_summary: string;
  bear_summary: string;
  total_tokens: number;
  total_cost_usd: number;
}

/** Research Manager scoring of the debate. */
export interface ResearchDecision {
  direction: "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell";
  confidence: number;
  bull_score: number;
  bear_score: number;
  reasoning: string;
  key_debate_points: string[];
  verdict: Verdict;
}

/** Trader execution plan with A-share specific constraints. */
export interface TradingPlan {
  direction: FinalDecision["direction"];
  target_price: number;
  stop_loss: number;
  position_pct: number;
  execution_plan: string;
  entry_signals: string[];
  exit_signals: string[];
  key_risks: string[];
  t_plus_1_note: string;
}

/** One risk debater's argument. */
export interface RiskArgument {
  role: "aggressive" | "conservative" | "neutral";
  position: string;
  evidence: string[];
  verdict: "pass" | "revise" | "reject";
}

/** Three-way risk debate result. */
export interface RiskDebateResult {
  rounds: RiskArgument[][];
  risk_arguments: RiskArgument[];
  total_tokens: number;
  total_cost_usd: number;
}

/** Risk Manager final assessment. */
export interface RiskAssessment {
  status: "pass" | "revise" | "reject";
  revised_plan?: TradingPlan;
  reasoning: string;
  risk_score: number;
  max_position_override?: number;
}

/** Full analysis result with debate and risk layers. */
export interface FullAnalysisResult {
  ticker: string;
  date: string;
  mode: "full";
  analysts: AnalystReport[];
  debate: DebateResult;
  research_decision: ResearchDecision;
  trading_plan: TradingPlan;
  risk_debate: RiskDebateResult;
  risk_assessment: RiskAssessment;
  final: FinalDecision;
}
```

Also update `LLMCallTrace.phase` to include new phases. Change line 79:

```typescript
  phase: "analyst" | "debate" | "research" | "trader" | "risk_debate" | "risk" | "portfolio";
```

- [ ] **Step 2: Build check**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run existing tests**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 26 tests pass

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add Phase 3 debate, research, trader, and risk types"
```

---

### Task 2: Create Debate Prompt Templates

**Files:**
- Create: `skills/trading-analysis/prompts/debate/bull_researcher.md`
- Create: `skills/trading-analysis/prompts/debate/bear_researcher.md`
- Create: `skills/trading-analysis/prompts/debate/research_manager.md`
- Create: `skills/trading-analysis/prompts/debate/trader.md`
- Create: `skills/trading-analysis/prompts/debate/risk_debater.md`
- Create: `skills/trading-analysis/prompts/debate/risk_manager.md`

- [ ] **Step 1: Create `bull_researcher.md`**

```markdown
# 多头研究员（Bull Researcher）

你是一位经验丰富的 A 股多头研究员。你的任务是从分析师报告中提取看多证据，构建有说服力的看多论点。

## A 股看多催化剂框架

在构建论点时，重点关注以下 A 股特有的看多催化剂：

1. **政策利好** — 行业扶持政策、监管放松、财政/货币政策支持
2. **北向资金净流入** — 外资持续买入信号
3. **板块联动效应** — 同板块个股联动上涨
4. **资金面改善** — 融资余额上升、主力资金净买入
5. **估值修复空间** — PE/PB 处于历史低位区间
6. **业绩催化** — 超预期财报、盈利上修

## 分析任务

标的：{{ticker}}
分析日期：{{date}}

## 分析师报告

{{analyst_reports}}

{{opponent_claims}}

## 输出要求

请按以下格式输出你的看多论点：

### 看多论点

对每个论点，提供：
- **论点 ID**：BULL-N（N 从 1 开始递增）
- **核心观点**（不超过 30 字）
- **支撑证据**（引用具体数据）
- **信心水平**：高/中/低
- **对方反驳预判**（如果是第 2 轮及以上）

### 论据总结

用 2-3 句话概括你的核心看多逻辑。

## 机器可读结论

在报告的最后一行，必须包含以下格式：

```html
<!-- VERDICT: {"direction": "看多", "reason": "不超过20字的核心看多理由"} -->
```
```

- [ ] **Step 2: Create `bear_researcher.md`**

```markdown
# 空头研究员（Bear Researcher）

你是一位经验丰富的 A 股空头研究员。你的任务是从分析师报告中提取看空风险，构建有说服力的看空论点，并反驳多头论点。

## A 股看空风险框架

在构建论点时，重点关注以下 A 股特有的看空风险：

1. **政策收紧** — 行业监管加强、限售解禁政策变化
2. **北向资金净流出** — 外资持续卖出信号
3. **解禁压力** — 大额限售股解禁时间窗口
4. **估值泡沫** — PE/PB 处于历史高位区间（PE>50x 且 PEG>2 为投机区间）
5. **T+1 陷阱** — 当日买入无法卖出的流动性风险
6. **资金面恶化** — 融资余额下降、主力资金净流出

## 分析任务

标的：{{ticker}}
分析日期：{{date}}

## 分析师报告

{{analyst_reports}}

{{opponent_claims}}

## 输出要求

请按以下格式输出你的看空论点：

### 看空论点

对每个论点，提供：
- **论点 ID**：BEAR-N（N 从 1 开始递增）
- **核心观点**（不超过 30 字）
- **支撑证据**（引用具体数据）
- **信心水平**：高/中/低
- **反驳对方论点**（如果有多头论点需要反驳，逐条回应）

### 风险总结

用 2-3 句话概括你的核心看空逻辑。

## 机器可读结论

在报告的最后一行，必须包含以下格式：

```html
<!-- VERDICT: {"direction": "看空", "reason": "不超过20字的核心看空理由"} -->
```
```

- [ ] **Step 3: Create `research_manager.md`**

```markdown
# 研究经理（Research Manager）

你是一位资深研究经理，负责评估多空辩论的质量并做出最终研究方向决策。你必须独立评估双方论点的质量，而非简单地取中间立场。

## 评分标准

- **证据质量**：论点是否有具体数据支撑？是否引用了分析师报告中的实际数据？
- **论证强度**：逻辑推理是否严密？是否存在逻辑漏洞？
- **反驳效果**：对对方论点的反驳是否有说服力？是否有效打穿了对方的薄弱假设？
- **A 股特殊因素**：是否充分考虑了 A 股市场的特殊性（政策影响、T+1、涨跌停板、北向资金等）？

## 决策等级

- **Buy**：多头论据充分，风险可控，建议积极建仓
- **Overweight**：多头论据较强，存在一定风险，建议适度超配
- **Hold**：多空力量均衡，方向不明，建议维持现有仓位
- **Underweight**：空头论据较强，建议降低仓位
- **Sell**：空头论据充分，风险显著，建议清仓

## 分析任务

标的：{{ticker}}
分析日期：{{date}}

## 分析师报告

{{analyst_reports}}

## 多空辩论记录

{{debate_rounds}}

### 多头总结
{{bull_summary}}

### 空头总结
{{bear_summary}}

## 输出要求

### 1. 评分

- **多头得分**（0-100）：___
- **空头得分**（0-100）：___
（注：两边评分独立，非零和。可以都高或都低。）

### 2. 关键辩论焦点（3-5 条）

列出辩论中最具争议和最重要的论点。

### 3. 最终决策

- **方向**：Buy / Overweight / Hold / Underweight / Sell
- **信心水平**（0-1）：___
- **决策理由**（3-5 句话）

## 机器可读结论

```html
<!-- VERDICT: {"direction": "Buy|Overweight|Hold|Underweight|Sell", "reason": "不超过20字的核心结论"} -->
```
```

- [ ] **Step 4: Create `trader.md`**

```markdown
# 交易员（Trader）

你是一位专业的 A 股交易员，负责根据研究经理的决策制定具体的交易执行计划。你必须严格遵守 A 股市场的交易规则。

## A 股交易约束

1. **T+1 交易制度** — 当日买入的股票只能在下一交易日卖出
2. **涨跌停板制度** — 主板±10%，科创板/创业板±20%，ST股±5%
3. **集合竞价规则** — 9:15-9:25 开盘集合竞价，14:57-15:00 收盘集合竞价
4. **最小交易单位** — 主板 100 股，科创板/创业板 200 股
5. **交易时间** — 9:30-11:30，13:00-15:00（北京时间）

## 分析任务

标的：{{ticker}}
分析日期：{{date}}

## 研究经理决策

{{research_decision}}

## 分析师报告摘要

{{analyst_reports}}

## 输出要求

请制定具体的交易执行计划：

### 1. 交易方向与仓位
- **建议方向**：买入/卖出/持有
- **建议仓位**：占总资金百分比
- **建仓方式**：一次性/分批（说明分几批，每批比例）

### 2. 价格区间
- **目标价格**：___ 元
- **止损价格**：___ 元
- **入场价格区间**：___ - ___ 元

### 3. 入场信号
列出触发建仓/加仓的具体信号条件（至少 2 条）。

### 4. 退出信号
列出触发减仓/清仓的具体信号条件（至少 2 条）。

### 5. T+1 操作约束说明
说明在 T+1 制度下的操作策略调整。

### 6. 关键风险提示
列出交易执行过程中需要关注的主要风险（至少 2 条）。

## 机器可读结论

```html
<!-- VERDICT: {"direction": "Buy|Overweight|Hold|Underweight|Sell", "reason": "不超过20字的核心结论"} -->
```
```

- [ ] **Step 5: Create `risk_debater.md`**

```markdown
# 风险评估员 — {{risk_role}}

你是一位 A 股风险评估员，当前角色为：**{{risk_role}}**。

## 角色定位

{{risk_role_instructions}}

## 分析任务

标的：{{ticker}}
分析日期：{{date}}

## 交易执行计划

{{trading_plan}}

## 分析师报告

{{analyst_reports}}

## 输出要求

### 1. 立场声明
明确你对交易计划的态度（支持/建议修订/反对）。

### 2. 证据支撑
列出支撑你立场的具体证据（至少 2 条），引用分析师数据。

### 3. 风险评估结论
- **verdict**：pass / revise / reject
- **理由**（2-3 句话）

## 机器可读结论

```html
<!-- VERDICT: {"direction": "pass|revise|reject", "reason": "不超过20字的风险评估结论"} -->
```
```

- [ ] **Step 6: Create `risk_manager.md`**

```markdown
# 风控经理（Risk Manager）

你是一位资深 A 股风控经理，负责综合三方风险评估意见，做出最终风控决策。

## 核心原则

**尊重上游方向判断**。你的职责是补充风控约束，而非推翻方向决策。只有在上游遗漏重大风险时才调整方向。

## 决策等级

- **pass** — 交易计划可执行，无需修改
- **revise** — 交易计划需修订（降低仓位、调整止损等），修订后可执行
- **reject** — 发现重大风险，建议暂缓交易

## 分析任务

标的：{{ticker}}
分析日期：{{date}}

## 交易执行计划

{{trading_plan}}

## 三方风险评估

{{risk_arguments}}

## 输出要求

### 1. 风险评分（0-100）
0 = 无风险，100 = 极高风险

### 2. 风控决策
- **status**：pass / revise / reject
- **理由**（3-5 句话）

### 3. 修订建议（仅 revise 时）
- **最大仓位上限**：___%（如果需要降低仓位）
- **修订要点**：具体建议

### 4. 硬性约束
列出交易执行过程中必须遵守的硬性约束。

### 5. 风险触发器
列出触发止损或重新评估的条件。

## 机器可读结论

```html
<!-- VERDICT: {"direction": "pass|revise|reject", "reason": "不超过20字的风控结论"} -->
```
```

- [ ] **Step 7: Commit**

```bash
git add skills/trading-analysis/prompts/debate/
git commit -m "feat: add 6 Phase 3 debate prompt templates"
```

---

### Task 3: Implement `src/debate.ts`

**Files:**
- Create: `src/debate.ts`
- Create: `tests/ts/debate.test.ts`

- [ ] **Step 1: Write `tests/ts/debate.test.ts`**

```typescript
// tests/ts/debate.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runBullBearDebate } from '../../src/debate';
import { TradingAgentsConfig, AnalystReport, DebateResult } from '../../src/types';
import OpenAI from 'openai';

const mockConfig: TradingAgentsConfig = {
  models: { analyst: 'gpt-4o', debater: 'gpt-4o', decision: 'gpt-4o', risk: 'gpt-4o' },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  report_dir: '/tmp/test-reports',
};

function mockAnalystReports(): AnalystReport[] {
  return [
    { role: 'market', content: 'Market analysis report', verdict: { direction: '看多', reason: '趋势向上' }, data_sources_used: ['kline'] },
    { role: 'fundamentals', content: 'Fundamentals report', verdict: { direction: '中性', reason: '估值合理' }, data_sources_used: ['fundamentals'] },
  ];
}

function mockDebateResponse(side: 'bull' | 'bear', round: number) {
  const prefix = side === 'bull' ? 'BULL' : 'BEAR';
  const direction = side === 'bull' ? '看多' : '看空';
  return {
    choices: [{
      message: {
        content: `${side} debate round ${round}.

### ${side === 'bull' ? '看多' : '看空'}论点

- **论点 ID**：${prefix}-${round}
- **核心观点**：Test claim ${round}
- **支撑证据**：Test evidence
- **信心水平**：中

### ${side === 'bull' ? '论据' : '风险'}总结
Test summary for ${side} round ${round}.

<!-- VERDICT: {"direction": "${direction}", "reason": "Test ${side} reason"} -->`
      }
    }],
    usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 }
  };
}

describe('runBullBearDebate', () => {
  let mockClient: OpenAI;
  let mockTraceLogger: any;

  beforeEach(() => {
    mockClient = {
      chat: { completions: { create: vi.fn() } }
    } as any;
    mockTraceLogger = { record: vi.fn(), count: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should run 2-round Bull↔Bear debate', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // Round 1: Bull then Bear
    mockCreate.mockResolvedValueOnce(mockDebateResponse('bull', 1) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse('bear', 1) as any);
    // Round 2: Bull then Bear
    mockCreate.mockResolvedValueOnce(mockDebateResponse('bull', 2) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse('bear', 2) as any);

    const reports = mockAnalystReports();
    const result = await runBullBearDebate(reports, mockConfig, mockClient, mockTraceLogger);

    // 2 rounds × 2 calls = 4 LLM calls
    expect(mockCreate).toHaveBeenCalledTimes(4);

    // Verify structure
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].round).toBe(1);
    expect(result.rounds[1].round).toBe(2);

    // Verify summaries extracted
    expect(result.bull_summary).toContain('Test summary for bull');
    expect(result.bear_summary).toContain('Test summary for bear');

    // Verify token tracking
    expect(result.total_tokens).toBe(3600); // 4 × 900
    expect(result.total_cost_usd).toBeGreaterThan(0);
  });

  it('should pass opponent claims to each subsequent turn', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // Round 1
    mockCreate.mockResolvedValueOnce(mockDebateResponse('bull', 1) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse('bear', 1) as any);
    // Round 2
    mockCreate.mockResolvedValueOnce(mockDebateResponse('bull', 2) as any);
    mockCreate.mockResolvedValueOnce(mockDebateResponse('bear', 2) as any);

    const reports = mockAnalystReports();
    await runBullBearDebate(reports, mockConfig, mockClient, mockTraceLogger);

    // Bear in round 1 should receive Bull's claims
    const bearR1Call = mockCreate.mock.calls[1];
    const bearR1Message = bearR1Call[0].messages.find((m: any) => m.role === 'user').content;
    expect(bearR1Message).toContain('BULL-1');

    // Bull in round 2 should receive Bear's round 1 claims
    const bullR2Call = mockCreate.mock.calls[2];
    const bullR2Message = bullR2Call[0].messages.find((m: any) => m.role === 'user').content;
    expect(bullR2Message).toContain('BEAR-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/debate.test.ts`
Expected: FAIL — `../../src/debate` does not exist

- [ ] **Step 3: Write `src/debate.ts`**

```typescript
// src/debate.ts

import OpenAI from "openai";
import { callLLM, parseVerdict } from "./llm-client";
import { loadAndRender } from "./prompt-loader";
import { TraceLogger } from "./trace-logger";
import {
  TradingAgentsConfig,
  AnalystReport,
  DebateResult,
  DebateRound,
  DebateClaim,
} from "./types";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

/**
 * Parse claims from LLM debate output.
 * Extracts BULL-N and BEAR-N claim blocks.
 */
function parseClaims(content: string, side: "bull" | "bear"): DebateClaim[] {
  const claims: DebateClaim[] = [];
  const prefix = side === "bull" ? "BULL" : "BEAR";
  const regex = /\*\*论点 ID\*\*：(BULL|BEAR)-(\d+)\s*\n[\s\S]*?\*\*核心观点\*\*[：:]\s*(.+)\n[\s\S]*?\*\*支撑证据\*\*[：:]\s*(.+)\n[\s\S]*?\*\*信心水平\*\*[：:]\s*(高|中|低)/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const id = `${match[1]}-${match[2]}`;
    const confidenceMap: Record<string, number> = { "高": 0.9, "中": 0.6, "低": 0.3 };
    claims.push({
      id,
      side,
      topic: match[3].trim(),
      evidence: match[4].trim(),
      confidence: confidenceMap[match[5]] ?? 0.5,
    });
  }
  return claims;
}

/**
 * Extract summary section from debate output.
 */
function extractSummary(content: string): string {
  const summaryRegex = /### (?:论据|风险)总结\s*\n([\s\S]*?)(?=\n<!-- VERDICT|$)/;
  const match = content.match(summaryRegex);
  return match ? match[1].trim() : content.slice(-200).trim();
}

/**
 * Run multi-round Bull↔Bear debate over analyst reports.
 *
 * Flow: Bull speaks first each round, Bear responds.
 * Each subsequent turn includes opponent's claims from the previous turn.
 */
export async function runBullBearDebate(
  analystReports: AnalystReport[],
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<DebateResult> {
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const reportsText = analystReports
    .map((r) => `## ${r.role} 分析师\n${r.content}`)
    .join("\n\n");

  const rounds: DebateRound[] = [];
  let totalTokens = 0;
  let totalCostUsd = 0;
  let bullSummary = "";
  let bearSummary = "";

  let lastBullClaims: DebateClaim[] = [];
  let lastBearClaims: DebateClaim[] = [];

  for (let round = 1; round <= config.debate_rounds; round++) {
    // ── Bull's turn ──
    const bullOpponentText = lastBearClaims.length > 0
      ? `## 对方（空头）论点\n\n${lastBearClaims.map((c) => `- [${c.id}] ${c.topic}：${c.evidence}`).join("\n")}`
      : "";

    const bullMessage = loadAndRender(
      "debate/bull_researcher.md",
      { ticker: analystReports[0]?.role || "", date: "", analyst_reports: reportsText, opponent_claims: bullOpponentText },
      promptsBaseDir
    );

    const bullResult = await callLLM(openaiClient, {
      model: config.models.debater,
      systemPrompt: "You are a bullish A-share researcher constructing evidence-based bull arguments.",
      userMessage: bullMessage,
      temperature: 0.5,
      maxTokens: 3000,
      phase: "debate",
      role: "bull",
      traceLogger,
    });

    totalTokens += bullResult.usage.total_tokens;
    totalCostUsd += bullResult.costUsd;

    const bullClaims = parseClaims(bullResult.content, "bull");
    const bullSummaryText = extractSummary(bullResult.content);

    // ── Bear's turn ──
    const bearOpponentText = bullClaims.length > 0
      ? `## 对方（多头）论点\n\n${bullClaims.map((c) => `- [${c.id}] ${c.topic}：${c.evidence}`).join("\n")}`
      : "";

    const bearMessage = loadAndRender(
      "debate/bear_researcher.md",
      { ticker: analystReports[0]?.role || "", date: "", analyst_reports: reportsText, opponent_claims: bearOpponentText },
      promptsBaseDir
    );

    const bearResult = await callLLM(openaiClient, {
      model: config.models.debater,
      systemPrompt: "You are a bearish A-share researcher identifying risks and countering bull arguments.",
      userMessage: bearMessage,
      temperature: 0.5,
      maxTokens: 3000,
      phase: "debate",
      role: "bear",
      traceLogger,
    });

    totalTokens += bearResult.usage.total_tokens;
    totalCostUsd += bearResult.costUsd;

    const bearClaims = parseClaims(bearResult.content, "bear");
    const bearSummaryText = extractSummary(bearResult.content);

    rounds.push({ round, bull_claims: bullClaims, bear_claims: bearClaims });

    lastBullClaims = bullClaims;
    lastBearClaims = bearClaims;
    bullSummary = bullSummaryText;
    bearSummary = bearSummaryText;
  }

  return { rounds, bull_summary: bullSummary, bear_summary: bearSummary, total_tokens: totalTokens, total_cost_usd: totalCostUsd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/debate.test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/debate.ts tests/ts/debate.test.ts
git commit -m "feat: add Bull↔Bear multi-round debate module with tests"
```

---

### Task 4: Implement `src/research-manager.ts`

**Files:**
- Create: `src/research-manager.ts`
- Create: `tests/ts/research_manager.test.ts`

- [ ] **Step 1: Write `tests/ts/research_manager.test.ts`**

```typescript
// tests/ts/research_manager.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runResearchManager } from '../../src/research-manager';
import { TradingAgentsConfig, AnalystReport, DebateResult } from '../../src/types';
import OpenAI from 'openai';

const mockConfig: TradingAgentsConfig = {
  models: { analyst: 'gpt-4o', debater: 'gpt-4o', decision: 'gpt-4o', risk: 'gpt-4o' },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  report_dir: '/tmp/test-reports',
};

function mockDebateResult(): DebateResult {
  return {
    rounds: [
      { round: 1, bull_claims: [{ id: 'BULL-1', side: 'bull', topic: '政策利好', evidence: '政策支持', confidence: 0.8 }], bear_claims: [{ id: 'BEAR-1', side: 'bear', topic: '估值偏高', evidence: 'PE高', confidence: 0.7 }] },
      { round: 2, bull_claims: [{ id: 'BULL-2', side: 'bull', topic: '北向流入', evidence: '净流入', confidence: 0.6 }], bear_claims: [{ id: 'BEAR-2', side: 'bear', topic: '解禁压力', evidence: '大额解禁', confidence: 0.5 }] },
    ],
    bull_summary: '多头逻辑：政策利好+北向流入',
    bear_summary: '空头风险：估值偏高+解禁压力',
    total_tokens: 3600,
    total_cost_usd: 0.01,
  };
}

describe('runResearchManager', () => {
  let mockClient: OpenAI;
  let mockTraceLogger: any;

  beforeEach(() => {
    mockClient = {
      chat: { completions: { create: vi.fn() } }
    } as any;
    mockTraceLogger = { record: vi.fn(), count: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should score debate and return ResearchDecision', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: `### 评分
- **多头得分**：75
- **空头得分**：45

### 关键辩论焦点
1. 政策利好是否持续
2. 估值是否合理

### 最终决策
- **方向**：Overweight
- **信心水平**：0.72

<!-- VERDICT: {"direction": "Overweight", "reason": "多头论据更充分"} -->`
        }
      }],
      usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 }
    } as any);

    const reports: AnalystReport[] = [
      { role: 'market', content: 'Market report', verdict: { direction: '看多', reason: '趋势向上' }, data_sources_used: ['kline'] },
    ];
    const debate = mockDebateResult();

    const result = await runResearchManager(reports, debate, mockConfig, mockClient, mockTraceLogger);

    expect(result.direction).toBe('Overweight');
    expect(result.confidence).toBe(0.72);
    expect(result.bull_score).toBe(75);
    expect(result.bear_score).toBe(45);
    expect(result.key_debate_points).toContain('政策利好是否持续');
    expect(result.verdict.direction).toBe('Overweight');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/research_manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/research-manager.ts`**

```typescript
// src/research-manager.ts

import OpenAI from "openai";
import { callLLM, parseVerdict } from "./llm-client";
import { loadAndRender } from "./prompt-loader";
import { TraceLogger } from "./trace-logger";
import {
  TradingAgentsConfig,
  AnalystReport,
  DebateResult,
  ResearchDecision,
} from "./types";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

/**
 * Parse bull/bear scores from Research Manager output.
 */
function parseScores(content: string): { bull_score: number; bear_score: number } {
  const bullMatch = content.match(/\*\*多头得分\*\*[：:]\s*(\d+)/);
  const bearMatch = content.match(/\*\*空头得分\*\*[：:]\s*(\d+)/);
  return {
    bull_score: bullMatch ? parseInt(bullMatch[1], 10) : 50,
    bear_score: bearMatch ? parseInt(bearMatch[1], 10) : 50,
  };
}

/**
 * Parse confidence from Research Manager output.
 */
function parseConfidence(content: string): number {
  const match = content.match(/\*\*信心水平\*\*[：:]\s*([\d.]+)/);
  return match ? parseFloat(match[1]) : 0.5;
}

/**
 * Parse key debate points from Research Manager output.
 */
function parseDebatePoints(content: string): string[] {
  const sectionMatch = content.match(/### 关键辩论焦点\s*\n([\s\S]*?)(?=\n###|\n<!-- VERDICT|$)/);
  if (!sectionMatch) return [];
  const lines = sectionMatch[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
  return lines;
}

/**
 * Parse 5-tier direction from text.
 */
function parse5TierDirection(raw: string): ResearchDecision["direction"] {
  const n = raw.toLowerCase().trim();
  if (n === "buy" || n === "买入") return "Buy";
  if (n === "overweight" || n === "增持") return "Overweight";
  if (n === "hold" || n === "持有" || n === "中性") return "Hold";
  if (n === "underweight" || n === "减持") return "Underweight";
  if (n === "sell" || n === "卖出") return "Sell";
  return "Hold";
}

/**
 * Run Research Manager to score the debate and decide direction.
 */
export async function runResearchManager(
  analystReports: AnalystReport[],
  debate: DebateResult,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<ResearchDecision> {
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const reportsText = analystReports
    .map((r) => `## ${r.role} 分析师\n${r.content}`)
    .join("\n\n");

  const debateRoundsText = debate.rounds
    .map((r) => {
      const bullText = r.bull_claims.map((c) => `[${c.id}] ${c.topic}（信心 ${c.confidence}）`).join("; ");
      const bearText = r.bear_claims.map((c) => `[${c.id}] ${c.topic}（信心 ${c.confidence}）`).join("; ");
      return `### Round ${r.round}\n多头论点：${bullText}\n空头论点：${bearText}`;
    })
    .join("\n\n");

  const userMessage = loadAndRender(
    "debate/research_manager.md",
    {
      ticker: "",
      date: "",
      analyst_reports: reportsText,
      debate_rounds: debateRoundsText,
      bull_summary: debate.bull_summary,
      bear_summary: debate.bear_summary,
    },
    promptsBaseDir
  );

  const result = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt: "You are a research manager evaluating Bull↔Bear debate quality and making trading direction decisions.",
    userMessage,
    temperature: 0.3,
    maxTokens: 3000,
    phase: "research",
    role: "research_manager",
    traceLogger,
  });

  const verdict = parseVerdict(result.content);
  const scores = parseScores(result.content);
  const confidence = parseConfidence(result.content);
  const keyPoints = parseDebatePoints(result.content);

  return {
    direction: parse5TierDirection(verdict?.direction || ""),
    confidence,
    bull_score: scores.bull_score,
    bear_score: scores.bear_score,
    reasoning: verdict?.reason || "",
    key_debate_points: keyPoints,
    verdict: verdict || { direction: "Hold", reason: "无法解析结论" },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/research_manager.test.ts`
Expected: 1 test PASS

- [ ] **Step 5: Commit**

```bash
git add src/research-manager.ts tests/ts/research_manager.test.ts
git commit -m "feat: add Research Manager with debate scoring and direction parsing"
```

---

### Task 5: Implement `src/trader.ts`

**Files:**
- Create: `src/trader.ts`
- Create: `tests/ts/trader.test.ts`

- [ ] **Step 1: Write `tests/ts/trader.test.ts`**

```typescript
// tests/ts/trader.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runTrader } from '../../src/trader';
import { TradingAgentsConfig, AnalystReport, ResearchDecision } from '../../src/types';
import OpenAI from 'openai';

const mockConfig: TradingAgentsConfig = {
  models: { analyst: 'gpt-4o', debater: 'gpt-4o', decision: 'gpt-4o', risk: 'gpt-4o' },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  report_dir: '/tmp/test-reports',
};

function mockResearchDecision(): ResearchDecision {
  return {
    direction: 'Overweight',
    confidence: 0.72,
    bull_score: 75,
    bear_score: 45,
    reasoning: '多头论据更充分',
    key_debate_points: ['政策利好'],
    verdict: { direction: 'Overweight', reason: '多头论据更充分' },
  };
}

describe('runTrader', () => {
  let mockClient: OpenAI;
  let mockTraceLogger: any;

  beforeEach(() => {
    mockClient = {
      chat: { completions: { create: vi.fn() } }
    } as any;
    mockTraceLogger = { record: vi.fn(), count: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should generate trading plan from research decision', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: `### 交易方向与仓位
- **建议方向**：买入
- **建议仓位**：30%
- **建仓方式**：分两批，第一批 60%，第二批 40%

### 价格区间
- **目标价格**：1400 元
- **止损价格**：1200 元
- **入场价格区间**：1260 - 1300 元

### T+1 操作约束说明
当日买入后次日才能卖出，建议分两日建仓。

### 关键风险提示
1. 政策变化风险
2. 市场系统性风险

<!-- VERDICT: {"direction": "Buy", "reason": "建议分批建仓"} -->`
        }
      }],
      usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 }
    } as any);

    const reports: AnalystReport[] = [
      { role: 'market', content: 'Market report', verdict: { direction: '看多', reason: 'up' }, data_sources_used: ['kline'] },
    ];
    const decision = mockResearchDecision();

    const result = await runTrader(decision, reports, mockConfig, mockClient, mockTraceLogger);

    expect(result.target_price).toBe(1400);
    expect(result.stop_loss).toBe(1200);
    expect(result.position_pct).toBe(30);
    expect(result.entry_signals.length).toBeGreaterThan(0);
    expect(result.exit_signals.length).toBeGreaterThan(0);
    expect(result.t_plus_1_note).toContain('T+1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/trader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/trader.ts`**

```typescript
// src/trader.ts

import OpenAI from "openai";
import { callLLM, parseVerdict } from "./llm-client";
import { loadAndRender } from "./prompt-loader";
import { TraceLogger } from "./trace-logger";
import {
  TradingAgentsConfig,
  AnalystReport,
  ResearchDecision,
  TradingPlan,
} from "./types";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

function parseNumberField(content: string, fieldRegex: RegExp): number {
  const match = content.match(fieldRegex);
  return match ? parseFloat(match[1]) : 0;
}

function parseListSection(content: string, header: string): string[] {
  const regex = new RegExp(`### ${header}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n###|\\n<!-- VERDICT|$)`);
  const match = content.match(regex);
  if (!match) return [];
  return match[1].split("\n")
    .map((l) => l.replace(/^\d+\.\s*/, "").replace(/^-\s*/, "").trim())
    .filter((l) => l.length > 0);
}

/**
 * Run Trader to create a concrete execution plan.
 */
export async function runTrader(
  researchDecision: ResearchDecision,
  analystReports: AnalystReport[],
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<TradingPlan> {
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const reportsText = analystReports
    .map((r) => `## ${r.role} 分析师\n${r.content}`)
    .join("\n\n");

  const decisionText = `方向：${researchDecision.direction}\n信心：${researchDecision.confidence}\n理由：${researchDecision.reasoning}\n辩论焦点：${researchDecision.key_debate_points.join("、")}`;

  const userMessage = loadAndRender(
    "debate/trader.md",
    {
      ticker: "",
      date: "",
      research_decision: decisionText,
      analyst_reports: reportsText,
    },
    promptsBaseDir
  );

  const result = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt: "You are an A-share trader creating specific execution plans based on research decisions.",
    userMessage,
    temperature: 0.3,
    maxTokens: 3000,
    phase: "trader",
    role: "trader",
    traceLogger,
  });

  const direction = researchDecision.direction;
  if (direction === "Overweight") {
    // map to Buy for FinalDecision
  }

  return {
    direction: direction === "Overweight" ? "Buy" : direction === "Underweight" ? "Sell" : direction,
    target_price: parseNumberField(result.content, /目标价格[：:]\s*([\d.]+)/),
    stop_loss: parseNumberField(result.content, /止损价格[：:]\s*([\d.]+)/),
    position_pct: parseNumberField(result.content, /建议仓位[：:]\s*(\d+)/),
    execution_plan: result.content.slice(0, 200),
    entry_signals: parseListSection(result.content, "入场信号"),
    exit_signals: parseListSection(result.content, "退出信号"),
    key_risks: parseListSection(result.content, "关键风险提示"),
    t_plus_1_note: (() => {
      const match = result.content.match(/### T\+1 操作约束说明\s*\n([\s\S]*?)(?=\n###|$)/);
      return match ? match[1].trim() : "T+1 制度：当日买入次日才能卖出";
    })(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/trader.test.ts`
Expected: 1 test PASS

- [ ] **Step 5: Commit**

```bash
git add src/trader.ts tests/ts/trader.test.ts
git commit -m "feat: add Trader module with A-share execution plan generation"
```

---

### Task 6: Implement `src/risk.ts`

**Files:**
- Create: `src/risk.ts`
- Create: `tests/ts/risk.test.ts`

- [ ] **Step 1: Write `tests/ts/risk.test.ts`**

```typescript
// tests/ts/risk.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runRiskDebate, runRiskManager } from '../../src/risk';
import { TradingAgentsConfig, TradingPlan, RiskDebateResult } from '../../src/types';
import OpenAI from 'openai';

const mockConfig: TradingAgentsConfig = {
  models: { analyst: 'gpt-4o', debater: 'gpt-4o', decision: 'gpt-4o', risk: 'gpt-4o' },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  report_dir: '/tmp/test-reports',
};

function mockTradingPlan(): TradingPlan {
  return {
    direction: 'Buy',
    target_price: 1400,
    stop_loss: 1200,
    position_pct: 30,
    execution_plan: '分两批建仓',
    entry_signals: ['价格回到1280'],
    exit_signals: ['跌破1200'],
    key_risks: ['政策变化'],
    t_plus_1_note: 'T+1制度',
  };
}

function mockRiskDebateResponse(role: string, verdict: string) {
  return {
    choices: [{
      message: {
        content: `### 1. 立场声明
${verdict === 'pass' ? '支持该交易计划' : verdict === 'revise' ? '建议修订仓位' : '反对该交易计划'}

### 2. 证据支撑
- 证据1：估值处于合理区间
- 证据2：北向资金持续流入

### 3. 风险评估结论
- **verdict**：${verdict}
- **理由**：风险可控

<!-- VERDICT: {"direction": "${verdict}", "reason": "${role} verdict: ${verdict}"} -->`
      }
    }],
    usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }
  };
}

describe('Risk Module', () => {
  let mockClient: OpenAI;
  let mockTraceLogger: any;

  beforeEach(() => {
    mockClient = {
      chat: { completions: { create: vi.fn() } }
    } as any;
    mockTraceLogger = { record: vi.fn(), count: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('runRiskDebate', () => {
    it('should run 3-way parallel risk debate', async () => {
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate
        .mockResolvedValueOnce(mockRiskDebateResponse('aggressive', 'pass') as any)
        .mockResolvedValueOnce(mockRiskDebateResponse('conservative', 'revise') as any)
        .mockResolvedValueOnce(mockRiskDebateResponse('neutral', 'pass') as any);

      const plan = mockTradingPlan();
      const reports = [{ role: 'market', content: 'Report', verdict: { direction: '看多', reason: 'up' }, data_sources_used: ['kline'] }];

      const result = await runRiskDebate(plan, reports, mockConfig, mockClient, mockTraceLogger);

      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(result.risk_arguments).toHaveLength(3);
      expect(result.risk_arguments[0].role).toBe('aggressive');
      expect(result.risk_arguments[1].role).toBe('conservative');
      expect(result.risk_arguments[2].role).toBe('neutral');
      expect(result.risk_arguments[0].verdict).toBe('pass');
      expect(result.risk_arguments[1].verdict).toBe('revise');
    });
  });

  describe('runRiskManager', () => {
    it('should return pass assessment', async () => {
      const mockCreate = vi.mocked(mockClient.chat.completions.create);
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: `### 1. 风险评分
45

### 2. 风控决策
- **status**：pass
- **理由**：风险可控，交易计划可执行

<!-- VERDICT: {"direction": "pass", "reason": "风险可控"} -->`
          }
        }],
        usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 }
      } as any);

      const debateResult: RiskDebateResult = {
        rounds: [[]],
        risk_arguments: [
          { role: 'aggressive', position: 'support', evidence: ['ev1'], verdict: 'pass' },
          { role: 'conservative', position: 'revise', evidence: ['ev2'], verdict: 'revise' },
          { role: 'neutral', position: 'support', evidence: ['ev3'], verdict: 'pass' },
        ],
        total_tokens: 2100,
        total_cost_usd: 0.005,
      };

      const result = await runRiskManager(debateResult, mockTradingPlan(), mockConfig, mockClient, mockTraceLogger);

      expect(result.status).toBe('pass');
      expect(result.risk_score).toBe(45);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/risk.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/risk.ts`**

```typescript
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

/**
 * Run 3-way parallel risk debate.
 */
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
      const userMessage = loadAndRender(
        "debate/risk_debater.md",
        {
          ticker: "",
          date: "",
          trading_plan: planText,
          analyst_reports: reportsText,
          risk_role: role === "aggressive" ? "激进风控" : role === "conservative" ? "保守风控" : "中性风控",
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
    total_tokens: 0, // filled by caller if needed
    total_cost_usd: 0,
  };
}

/**
 * Run Risk Manager to make final risk assessment.
 */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/risk.test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/risk.ts tests/ts/risk.test.ts
git commit -m "feat: add 3-way risk debate and risk manager modules"
```

---

### Task 7: Extend Orchestrator with `runFullAnalysis()`

**Files:**
- Modify: `src/orchestrator.ts`

- [ ] **Step 1: Extract `runAnalystPhase()` and add `runFullAnalysis()`**

At the top of `src/orchestrator.ts`, add imports:

```typescript
import { runBullBearDebate } from "./debate";
import { runResearchManager } from "./research-manager";
import { runTrader } from "./trader";
import { runRiskDebate, runRiskManager } from "./risk";
import {
  TradingAgentsConfig,
  QuickAnalysisResult,
  FullAnalysisResult,
  AnalystReport,
  FinalDecision,
  ScriptResult,
} from "./types";
```

Then extract the Phase 1-2 logic from `runQuickAnalysis()` into a shared `runAnalystPhase()` function. Add it before `runQuickAnalysis()`:

```typescript
/**
 * Shared Phase 1-2: fetch data + run 7 analysts in parallel.
 * Used by both runQuickAnalysis() and runFullAnalysis().
 */
async function runAnalystPhase(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<{ analystReports: AnalystReport[]; totalTokens: number; totalCostUsd: number }> {
  let totalTokens = 0;
  let totalCostUsd = 0;

  // ── Phase 1: Fetch data from all 7 scripts in parallel ──────────
  const dataResults = await Promise.all(
    ANALYST_CONFIGS.map(async (cfg) => {
      const scriptPath = path.join(SKILLS_DIR, cfg.script);
      const args = ["--ticker", ticker, "--date", date, ...cfg.extraArgs(ticker)];
      try {
        const result: ScriptResult = await execPython(scriptPath, args);
        return { role: cfg.role, result };
      } catch (err: any) {
        return { role: cfg.role, result: { success: false, error: err.message } as ScriptResult };
      }
    })
  );

  const dataMap: Record<string, string> = {};
  for (const { role, result } of dataResults) {
    if (result.success && result.data) {
      dataMap[role] = JSON.stringify(result.data, null, 2);
    } else {
      dataMap[role] = `[数据缺失: ${result.error || "unknown error"}]`;
    }
  }

  // ── Phase 2: Run all 7 analysts in parallel ─────────────────────
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const analystPromises = ANALYST_CONFIGS.map(async (cfg) => {
    try {
      const dataJson = dataMap[cfg.role];
      const userMessage = loadAndRender(
        cfg.prompt,
        { ticker, date, [cfg.dataKey]: dataJson },
        promptsBaseDir
      );

      const llmResult = await callLLM(openaiClient, {
        model: config.models.analyst,
        systemPrompt: cfg.systemPrompt,
        userMessage,
        temperature: 0.4,
        maxTokens: 4000,
        phase: "analyst",
        role: cfg.role,
        traceLogger,
      });

      totalTokens += llmResult.usage.total_tokens;
      totalCostUsd += llmResult.costUsd;

      const verdict = parseVerdict(llmResult.content);

      return {
        role: cfg.role,
        content: llmResult.content,
        verdict: verdict || { direction: "中性", reason: "无法解析结论" },
        data_sources_used: [cfg.dataKey],
      } as AnalystReport;
    } catch (err: any) {
      return {
        role: cfg.role,
        content: `[分析失败: ${err.message}]`,
        verdict: { direction: "中性", reason: "分析失败" },
        data_sources_used: [],
      } as AnalystReport;
    }
  });

  const analystReports = await Promise.all(analystPromises);
  return { analystReports, totalTokens, totalCostUsd };
}
```

Refactor `runQuickAnalysis()` to use it:

```typescript
export async function runQuickAnalysis(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI
): Promise<QuickAnalysisResult> {
  const startTime = Date.now();
  const traceDir = path.join(os.homedir(), ".openclaw", "traces", `${ticker}_${date}`);
  const traceLogger = new TraceLogger(traceDir);
  const reportStore = new ReportStore(config.report_dir);

  const { analystReports, totalTokens, totalCostUsd } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger);

  // ── Portfolio Manager ────────────────────────────────────────────
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
  const allReportsText = analystReports
    .map((r) => `## ${r.role} 分析师报告\n\n${r.content}\n\nVERDICT: ${r.verdict.direction} — ${r.verdict.reason}`)
    .join("\n\n---\n\n");

  const portfolioPrompt = loadAndRender("portfolio_manager.md", { ticker, date, analyst_reports: allReportsText }, promptsBaseDir);

  const portfolioResult = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt: "You are a portfolio manager making final trading decisions based on analyst reports.",
    userMessage: portfolioPrompt,
    temperature: 0.3,
    maxTokens: 4000,
    phase: "portfolio",
    role: "portfolio_manager",
    traceLogger,
  });

  const allTokens = totalTokens + portfolioResult.usage.total_tokens;
  const allCost = totalCostUsd + portfolioResult.costUsd;

  const portfolioVerdict = parseVerdict(portfolioResult.content);
  if (!portfolioVerdict) {
    throw new Error("Failed to parse portfolio manager verdict from LLM response");
  }

  const analystVerdicts: Record<string, string> = {};
  for (const report of analystReports) {
    analystVerdicts[report.role] = report.verdict.direction;
  }

  const finalDecision: FinalDecision = {
    ticker,
    company_name: ticker,
    date,
    direction: parseDirection(portfolioVerdict.direction),
    confidence: 0.7,
    target_price: 0,
    stop_loss: 0,
    position_pct: 0,
    reasoning: portfolioVerdict.reason,
    key_risks: [],
    analyst_verdicts: analystVerdicts,
    bull_bear_summary: "",
    risk_assessment: "pass",
    execution_plan: "",
    next_review_trigger: "",
  };

  const result: QuickAnalysisResult = { ticker, date, mode: "quick", analysts: analystReports, final: finalDecision };
  const durationMs = Date.now() - startTime;
  reportStore.save(ticker, date, "quick", result, durationMs, allTokens, allCost);
  return result;
}
```

Add `runFullAnalysis()` after `runQuickAnalysis()`:

```typescript
/**
 * Run full analysis workflow with debate and risk layers:
 * 1. 7 analysts (parallel) — shared runAnalystPhase
 * 2. Bull↔Bear debate (multi-round)
 * 3. Research Manager (scores debate)
 * 4. Trader (execution plan)
 * 5. Risk Debate (3-way parallel)
 * 6. Risk Manager (pass/revise/reject) with revise loop
 * 7. Assemble FullAnalysisResult
 */
export async function runFullAnalysis(
  ticker: string,
  date: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI
): Promise<FullAnalysisResult> {
  const startTime = Date.now();
  const traceDir = path.join(os.homedir(), ".openclaw", "traces", `${ticker}_${date}_full`);
  const traceLogger = new TraceLogger(traceDir);
  const reportStore = new ReportStore(config.report_dir);

  // Phase 1-2: Analysts
  const { analystReports, totalTokens: analystTokens, totalCostUsd: analystCost } =
    await runAnalystPhase(ticker, date, config, openaiClient, traceLogger);

  // Phase 3: Bull↔Bear Debate
  const debate = await runBullBearDebate(analystReports, config, openaiClient, traceLogger);

  // Phase 4: Research Manager
  const researchDecision = await runResearchManager(analystReports, debate, config, openaiClient, traceLogger);

  // Phase 5: Trader (with revise loop)
  let tradingPlan = await runTrader(researchDecision, analystReports, config, openaiClient, traceLogger);

  // Phase 6-7: Risk Debate + Risk Manager (with revise loop)
  let riskDebate = await runRiskDebate(tradingPlan, analystReports, config, openaiClient, traceLogger);
  let riskAssessment = await runRiskManager(riskDebate, tradingPlan, config, openaiClient, traceLogger);

  let retries = 0;
  while (riskAssessment.status === "revise" && retries < config.max_risk_retries) {
    retries++;
    tradingPlan = await runTrader(researchDecision, analystReports, config, openaiClient, traceLogger);
    if (riskAssessment.max_position_override) {
      tradingPlan.position_pct = Math.min(tradingPlan.position_pct, riskAssessment.max_position_override);
    }
    riskDebate = await runRiskDebate(tradingPlan, analystReports, config, openaiClient, traceLogger);
    riskAssessment = await runRiskManager(riskDebate, tradingPlan, config, openaiClient, traceLogger);
  }

  // If still revise after max retries, treat as pass
  if (riskAssessment.status === "revise") {
    riskAssessment = { ...riskAssessment, status: "pass" };
  }

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
  reportStore.saveFull(ticker, date, result, durationMs);
  return result;
}
```

- [ ] **Step 2: Build check**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run ALL existing tests**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: All existing 26 tests + new 5 tests pass (31 total)

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: add runFullAnalysis() with debate → research → trader → risk pipeline"
```

---

### Task 8: Extend ReportStore for Full Mode

**Files:**
- Modify: `src/report-store.ts`
- Modify: `tests/ts/report_store.test.ts`

- [ ] **Step 1: Add `saveFull()` to `src/report-store.ts`**

Add the import at the top:

```typescript
import { QuickAnalysisResult, AnalysisReport, FullAnalysisResult } from "./types";
```

Append after the existing `save()` method (before the closing `}` of the class):

```typescript
  /**
   * Save a full analysis result to disk.
   * Creates structured directory layout with debate/research/trader/risk subdirs.
   */
  saveFull(
    ticker: string,
    date: string,
    result: FullAnalysisResult,
    durationMs: number
  ): void {
    const tickerDir = path.join(this.baseDir, ticker);
    const detailDir = path.join(tickerDir, `${date}_full`);
    fs.mkdirSync(path.join(detailDir, "01_analysts"), { recursive: true });
    fs.mkdirSync(path.join(detailDir, "02_debate"), { recursive: true });
    fs.mkdirSync(path.join(detailDir, "05_risk"), { recursive: true });

    // 01_analysts
    for (const report of result.analysts) {
      fs.writeFileSync(
        path.join(detailDir, "01_analysts", `${report.role}.json`),
        JSON.stringify(report, null, 2), "utf-8"
      );
    }

    // 02_debate
    for (const round of result.debate.rounds) {
      fs.writeFileSync(
        path.join(detailDir, "02_debate", `round_${round.round}.json`),
        JSON.stringify(round, null, 2), "utf-8"
      );
    }

    // 03_research
    fs.writeFileSync(
      path.join(detailDir, "03_research.json"),
      JSON.stringify(result.research_decision, null, 2), "utf-8"
    );

    // 04_trading_plan
    fs.writeFileSync(
      path.join(detailDir, "04_trading_plan.json"),
      JSON.stringify(result.trading_plan, null, 2), "utf-8"
    );

    // 05_risk
    fs.writeFileSync(
      path.join(detailDir, "05_risk", "risk_debate.json"),
      JSON.stringify(result.risk_debate, null, 2), "utf-8"
    );
    fs.writeFileSync(
      path.join(detailDir, "05_risk", "risk_manager.json"),
      JSON.stringify(result.risk_assessment, null, 2), "utf-8"
    );

    // Summary
    const analystVerdicts: Record<string, { direction: string; reason: string }> = {};
    for (const report of result.analysts) {
      analystVerdicts[report.role] = report.verdict;
    }

    const summary: AnalysisReport = {
      id: `${ticker}_${date}_full`,
      ticker,
      company_name: result.final.company_name,
      date,
      mode: "full",
      created_at: new Date().toISOString(),
      duration_ms: durationMs,
      total_tokens: 0,
      total_cost_usd: 0,
      final: result.final,
      analyst_verdicts: analystVerdicts,
      detail_dir: `${date}_full/`,
      trace_count: result.analysts.length + 4 + 1 + 1 + 3 + 1, // analysts + debate + research + trader + risk_debate + risk_mgr
    };

    fs.writeFileSync(
      path.join(tickerDir, `${date}_full.json`),
      JSON.stringify(summary, null, 2), "utf-8"
    );
  }
```

- [ ] **Step 2: Build check**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run existing tests**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/report_store.test.ts`
Expected: 1 test PASS (existing test unaffected)

- [ ] **Step 4: Commit**

```bash
git add src/report-store.ts
git commit -m "feat: add ReportStore.saveFull() with debate/research/trader/risk subdirs"
```

---

### Task 9: Register `trading_full` Tool

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import and register new tool**

Add import at top of `src/index.ts`:

```typescript
import { runFullAnalysis } from "./orchestrator";
```

After the `trading_quick` tool registration block (after line 63), add the `trading_full` tool:

```typescript
    // Register trading_full tool
    api.registerTool({
      name: "trading_full",
      label: "Full Stock Analysis (with Debate)",
      description: "Run a full A-share stock analysis with multi-round Bull↔Bear debate, research manager, trader execution plan, and risk assessment.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "A-share stock code (e.g. 600519)" },
          date: { type: "string", description: "Analysis date YYYY-MM-DD. Defaults to today." },
        },
        required: ["ticker"],
      },
      async execute(toolCallId: string, params: { ticker: string; date?: string }) {
        const date = params.date || new Date().toISOString().split("T")[0];
        try {
          const result = await runFullAnalysis(params.ticker, date, config, client);
          return { type: "text", text: JSON.stringify(result, null, 2) };
        } catch (err: any) {
          return {
            type: "text",
            text: JSON.stringify({
              error: true,
              message: err.message,
              ticker: params.ticker
            })
          };
        }
      },
    });
```

Also update the `trading_report` tool to support full mode. Change the file lookup to check for both modes:

```typescript
    api.registerTool({
      name: "trading_report",
      label: "Query Analysis Report",
      description: "Query a saved stock analysis report by ticker and date.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          mode: { type: "string", description: "Report mode: quick or full. Defaults to quick." },
        },
        required: ["ticker", "date"],
      },
      async execute(toolCallId: string, params: { ticker: string; date: string; mode?: string }) {
        const reportDir = config.report_dir.replace("~", os.homedir());
        const mode = params.mode || "quick";
        const filePath = path.join(reportDir, params.ticker, `${params.date}_${mode}.json`);
        const fs = await import("fs");
        if (!fs.existsSync(filePath)) {
          return { type: "text", text: JSON.stringify({ error: "Report not found" }) };
        }
        return { type: "text", text: fs.readFileSync(filePath, "utf-8") };
      },
    });
```

- [ ] **Step 2: Build check**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register trading_full tool with full debate pipeline"
```

---

### Task 10: Full Analysis Integration Test

**Files:**
- Modify: `tests/ts/integration.test.ts`

- [ ] **Step 1: Add full analysis test to integration test file**

Add the import at the top:

```typescript
import { runFullAnalysis } from '../../src/orchestrator';
```

Add the test at the end of the file (before the final `});`):

```typescript
  it('should run full analysis with debate → research → trader → risk', async () => {
    // Mock execPython
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // 7 analyst responses
    for (const role of ANALYST_ROLES) {
      mockCreate.mockResolvedValueOnce(
        mockAnalystResponse(role, '看多', `${role} reason`) as any
      );
    }

    // Debate: 2 rounds × 2 sides = 4 calls
    for (let round = 1; round <= 2; round++) {
      // Bull
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: `BULL-${round} claim. Evidence: test.\n\n### 论据总结\nBull summary round ${round}\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull reason"} -->` } }],
        usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 }
      } as any);
      // Bear
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: `BEAR-${round} claim. Evidence: test.\n\n### 风险总结\nBear summary round ${round}\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear reason"} -->` } }],
        usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 }
      } as any);
    }

    // Research Manager
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 评分\n- **多头得分**：70\n- **空头得分**：40\n\n### 关键辩论焦点\n1. 政策利好\n\n### 最终决策\n- **方向**：Overweight\n- **信心水平**：0.75\n\n<!-- VERDICT: {"direction": "Overweight", "reason": "bull wins"} -->` } }],
      usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 }
    } as any);

    // Trader
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：25%\n\n### 价格区间\n- **目标价格**：1400 元\n- **止损价格**：1200 元\n\n### 入场信号\n1. 价格回调到1280\n\n### 退出信号\n1. 跌破1200\n\n### T+1 操作约束说明\nT+1制度：当日买入次日才能卖出\n\n### 关键风险提示\n1. 政策风险\n\n<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->` } }],
      usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 }
    } as any);

    // Risk Debate: 3 parallel calls
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 1. 立场声明\n支持\n\n### 2. 证据支撑\n- 证据1\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }],
      usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }
    } as any);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 1. 立场声明\n审慎\n\n### 2. 证据支撑\n- 证据2\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }],
      usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }
    } as any);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 1. 立场声明\n中立支持\n\n### 2. 证据支撑\n- 证据3\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }],
      usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }
    } as any);

    // Risk Manager
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 1. 风险评分\n35\n\n### 2. 风控决策\n- **status**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->` } }],
      usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 }
    } as any);

    const result = await runFullAnalysis('600519', '2026-06-05', config, mockClient);

    // Verify structure
    expect(result.mode).toBe('full');
    expect(result.analysts).toHaveLength(7);
    expect(result.debate.rounds).toHaveLength(2);
    expect(result.research_decision.direction).toBe('Overweight');
    expect(result.trading_plan.target_price).toBe(1400);
    expect(result.risk_assessment.status).toBe('pass');

    // Total LLM calls: 7 analysts + 4 debate + 1 research + 1 trader + 3 risk + 1 risk_mgr = 17
    expect(mockCreate).toHaveBeenCalledTimes(17);

    // Verify report files
    const summaryFile = join(tmpReportDir, '600519', '2026-06-05_full.json');
    expect(existsSync(summaryFile)).toBe(true);

    const detailDir = join(tmpReportDir, '600519', '2026-06-05_full');
    expect(existsSync(join(detailDir, '02_debate', 'round_1.json'))).toBe(true);
    expect(existsSync(join(detailDir, '03_research.json'))).toBe(true);
    expect(existsSync(join(detailDir, '04_trading_plan.json'))).toBe(true);
    expect(existsSync(join(detailDir, '05_risk', 'risk_manager.json'))).toBe(true);
  });
```

- [ ] **Step 2: Run integration tests**

Run: `node node_modules/vitest/vitest.mjs run tests/ts/integration.test.ts`
Expected: 5 tests PASS (4 existing + 1 new)

- [ ] **Step 3: Run all tests**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: All tests pass (5 integration + 2 debate + 1 research + 1 trader + 2 risk + 6 prompt_loader + 2 trace_logger + 1 report_store + 13 exec_python = 33 tests)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Successful build

- [ ] **Step 5: Commit**

```bash
git add tests/ts/integration.test.ts
git commit -m "test: add full analysis integration test (17 LLM calls end-to-end)"
```

---

### Task 11: Final Build & Test Verification

- [ ] **Step 1: Run full TypeScript build**

Run: `npm run build`
Expected: Successful compilation

- [ ] **Step 2: Run full test suite**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: All tests pass

- [ ] **Step 3: Verify dist/ output**

Run: `ls dist/`
Expected: All new modules present (`debate.js`, `research-manager.js`, `trader.js`, `risk.js`)

- [ ] **Step 4: Final commit (if any remaining changes)**

```bash
git add -A
git commit -m "chore: Phase 3 complete — debate mechanism with full pipeline"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - Pipeline architecture (Section 1) → Task 7 (runFullAnalysis), Task 9 (tool registration)
   - Types (Section 2) → Task 1
   - Prompt templates (Section 3) → Task 2
   - Debate flow (Section 4) → Task 3 (Bull↔Bear), Task 4 (Research Manager), Task 5 (Trader), Task 6 (Risk)
   - File organization (Section 5) → covered by all tasks
   - ReportStore (Section 6) → Task 8
   - Testing strategy (Section 7) → Tasks 3-6, 10
   - Trace logging (Section 8) → uses existing TraceLogger with new phase/role values

2. **Placeholder scan:** No TBD, TODO, or "implement later" found.

3. **Type consistency:**
   - `DebateResult` defined in Task 1, used in Tasks 3, 4, 7
   - `ResearchDecision` defined in Task 1, used in Tasks 4, 5, 7
   - `TradingPlan` defined in Task 1, used in Tasks 5, 6, 7, 8
   - `RiskDebateResult` defined in Task 1, used in Tasks 6, 7
   - `RiskAssessment` defined in Task 1, used in Tasks 6, 7
   - `FullAnalysisResult` defined in Task 1, used in Tasks 7, 8, 10
   - `LLMCallTrace.phase` updated in Task 1 to include new phases
   - All function signatures match between definition and call sites
