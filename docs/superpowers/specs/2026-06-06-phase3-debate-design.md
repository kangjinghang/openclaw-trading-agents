# Phase 3: Bull↔Bear Debate Mechanism — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a multi-round Bull↔Bear debate layer and three-way risk debate on top of the 7-analyst parallel pipeline, producing higher-quality trading decisions through adversarial reasoning.

**Architecture:** Sequential stage functions, each encapsulating one phase of the debate pipeline. The orchestrator chains them together. Quick mode (`runQuickAnalysis`) stays unchanged; full mode (`runFullAnalysis`) adds 5 new stages after the 7-analyst phase.

**Tech Stack:** TypeScript, OpenAI-compatible LLM API, Vitest for testing.

---

## 1. Pipeline Architecture

### Quick mode (unchanged)

```
7 Analysts (parallel) → Portfolio Manager → Final Decision
```

### Full mode (new)

```
7 Analysts (parallel)
  → Bull ↔ Bear Debate (configurable rounds, default 2)
  → Research Manager (scores debate, assigns direction)
  → Trader (creates execution plan with A-share constraints)
  → Risk Debate (Aggressive vs Conservative vs Neutral, parallel, default 1 round)
  → Risk Manager (pass/revise/reject)
  → Final Decision (assembled)
```

Each stage is an independent function:

- `runAnalystPhase(ticker, date, config, client)` — extracted from current `runQuickAnalysis()`, returns `AnalystReport[]`
- `runBullBearDebate(analystReports, config, client, traceLogger)` → `DebateResult`
- `runResearchManager(analystReports, debate, config, client, traceLogger)` → `ResearchDecision`
- `runTrader(researchDecision, analystReports, config, client, traceLogger)` → `TradingPlan`
- `runRiskDebate(tradingPlan, analystReports, config, client, traceLogger)` → `RiskDebateResult`
- `runRiskManager(riskDebate, tradingPlan, config, client, traceLogger)` → `RiskAssessment`

Entry point: `runFullAnalysis()` in `src/orchestrator.ts` chains all stages.

`runQuickAnalysis()` continues to work unchanged for backward compatibility.

---

## 2. Types & Data Structures

All new types go in `src/types.ts`.

### Debate types

```typescript
/** A single debate claim with structured evidence. */
interface DebateClaim {
  id: string;          // e.g. "bull_1", "bear_2"
  side: "bull" | "bear";
  topic: string;       // claim summary
  evidence: string;    // supporting evidence
  confidence: number;  // 0-1
  responded_by?: string; // opponent's claim id that rebuts this
}

/** One round of Bull↔Bear debate. */
interface DebateRound {
  round: number;
  bull_claims: DebateClaim[];
  bear_claims: DebateClaim[];
}

/** Full Bull↔Bear debate result. */
interface DebateResult {
  rounds: DebateRound[];
  bull_summary: string;
  bear_summary: string;
  total_tokens: number;
  total_cost_usd: number;
}
```

### Research Manager types

```typescript
/** Research Manager scoring of the debate. */
interface ResearchDecision {
  direction: "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell";
  confidence: number;    // 0-1
  bull_score: number;    // 0-100
  bear_score: number;    // 0-100
  reasoning: string;
  key_debate_points: string[];
  verdict: Verdict;      // machine-readable via <!-- VERDICT -->
}
```

### Trader types

```typescript
/** Trader execution plan with A-share specific constraints. */
interface TradingPlan {
  direction: FinalDecision["direction"];
  target_price: number;
  stop_loss: number;
  position_pct: number;     // suggested position percentage
  execution_plan: string;   // e.g. "分批建仓, 逢低吸纳"
  entry_signals: string[];
  exit_signals: string[];
  key_risks: string[];
  t_plus_1_note: string;    // T+1 constraint note
}
```

### Risk debate types

```typescript
/** One risk debater's argument. */
interface RiskArgument {
  role: "aggressive" | "conservative" | "neutral";
  position: string;
  evidence: string[];
  verdict: "pass" | "revise" | "reject";
}

/** Three-way risk debate result. */
interface RiskDebateResult {
  rounds: RiskArgument[][];
  risk_arguments: RiskArgument[];
  total_tokens: number;
  total_cost_usd: number;
}

/** Risk Manager final assessment. */
interface RiskAssessment {
  status: "pass" | "revise" | "reject";
  revised_plan?: TradingPlan;  // present if status === "revise"
  reasoning: string;
  risk_score: number;          // 0-100
  max_position_override?: number;
}
```

### Full analysis result

```typescript
/** Full analysis result with debate and risk layers. */
interface FullAnalysisResult extends QuickAnalysisResult {
  mode: "full";
  debate: DebateResult;
  research_decision: ResearchDecision;
  trading_plan: TradingPlan;
  risk_debate: RiskDebateResult;
  risk_assessment: RiskAssessment;
}
```

### Config (already exists, no changes needed)

`TradingAgentsConfig` already has:
- `debate_rounds: number` (default 2)
- `risk_debate_rounds: number` (default 1)
- `max_risk_retries: number` (default 1)
- `models.debater: string`
- `models.risk: string`

---

## 3. Prompt Templates

6 new prompt templates in `skills/trading-analysis/prompts/debate/`:

### 3.1 `bull_researcher.md`

**Role:** Extract bullish evidence from 7 analyst reports.

**A-share catalyst framework:**
- 政策利好（行业扶持、监管放松）
- 北向资金净流入
- 板块联动效应
- 资金面改善（融资余额上升、主力净买入）

**Input variables:** `{{ticker}}`, `{{date}}`, `{{analyst_reports}}`

**Output format:** Structured claim list with id/evidence/confidence, ending with `<!-- VERDICT: {"direction": "看多", "reason": "..."} -->`

### 3.2 `bear_researcher.md`

**Role:** Extract bearish risks from 7 analyst reports + rebut Bull claims.

**A-share risk framework:**
- 政策收紧（行业监管、限售解禁）
- 北向资金净流出
- 解禁压力（大额解禁时间窗口）
- 估值偏高（PE/PB 分位数）

**Input variables:** `{{ticker}}`, `{{date}}`, `{{analyst_reports}}`, `{{opponent_claims}}` (Bull claims from current round, empty in round 1)

**Output format:** Same structured claims + `<!-- VERDICT -->`

### 3.3 `research_manager.md`

**Role:** Debate moderator and scorer. Synthesizes all debate rounds into a trading direction.

**Input variables:** `{{ticker}}`, `{{date}}`, `{{analyst_reports}}`, `{{debate_rounds}}`, `{{bull_summary}}`, `{{bear_summary}}`

**Output:**
- bull_score / bear_score (0-100)
- direction (Buy/Overweight/Hold/Underweight/Sell)
- confidence (0-1)
- key_debate_points (top 3-5 debate focus areas)
- `<!-- VERDICT -->`

### 3.4 `trader.md`

**Role:** Create specific execution plan given Research Manager decision.

**A-share constraints baked in:**
- T+1 settlement (买入当天不能卖出)
- 涨跌停板 (±10% for main board, ±20% for 创业板/科创板)
- 集合竞价规则 (9:15-9:25 / 14:57-15:00)

**Input variables:** `{{ticker}}`, `{{date}}`, `{{research_decision}}`, `{{analyst_reports}}`

**Output:** target_price, stop_loss, position_pct, entry_signals, exit_signals, execution_plan, key_risks

### 3.5 `risk_debater.md`

**Role:** Shared template for all three risk perspectives. Differentiated by `{{risk_role}}` variable.

**Roles:**
- **Aggressive:** 关注政策底信号、北向确认、涨停板效应、市场情绪亢奋期
- **Conservative:** 关注 T+1 陷阱、解禁压力、政策反复风险、流动性危机
- **Neutral:** 分层信号验证（强信号/弱信号/噪音），综合打分

**Input variables:** `{{ticker}}`, `{{date}}`, `{{trading_plan}}`, `{{analyst_reports}}`, `{{risk_role}}`

**Output:** position, evidence[], verdict (pass/revise/reject), `<!-- VERDICT -->`

### 3.6 `risk_manager.md`

**Role:** Final risk gate. Synthesizes three risk perspectives into pass/revise/reject decision.

**Input variables:** `{{ticker}}`, `{{date}}`, `{{trading_plan}}`, `{{risk_arguments}}`

**Output:**
- status (pass/revise/reject)
- risk_score (0-100)
- reasoning
- max_position_override (if revising)
- revised_plan details (if revising)

---

## 4. Debate Flow

### 4.1 Bull↔Bear Debate (2 rounds default)

```
Round 1:
  Bull: sees 7 analyst reports → extracts bullish claims (3-5 claims)
  Bear: sees 7 analyst reports + Bull's claims → rebuts + raises bearish claims

Round 2:
  Bull: sees Bear's rebuttal → responds to criticisms + adds new evidence
  Bear: sees Bull's response → final rebuttal + summarizes risks
```

Bull speaks first (affirmative burden). Each subsequent turn includes the opponent's claims from the previous turn so the debater can respond directly.

### 4.2 Research Manager

Receives all analyst reports + all debate rounds + summaries. Scores both sides independently (not zero-sum). Picks direction from 5-tier scale (Buy/Overweight/Hold/Underweight/Sell).

### 4.3 Trader

Receives Research Manager decision + analyst reports. Creates concrete execution plan. Must respect A-share market mechanics (T+1, price limits, auction rules).

### 4.4 Risk Debate (1 round, 3-way parallel)

```
Round 1:
  Aggressive Risk ─┐
  Conservative Risk ├── parallel LLM calls
  Neutral Risk ─────┘

Risk Manager: synthesizes 3 perspectives → pass/revise/reject
```

All three risk debaters are called in parallel via `Promise.all()`.

### 4.5 Revise Loop

If Risk Manager returns `"revise"` and `retries < max_risk_retries`:
1. Re-call `runTrader()` with Risk Manager's revision suggestions
2. Re-call `runRiskDebate()` with revised plan
3. Re-call `runRiskManager()` with new risk debate
4. If still `"revise"` after max retries, treat as `"pass"` (avoid infinite loop)

---

## 5. File Organization

### New files

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
| `src/types.ts` | Add all new types (DebateClaim, DebateRound, DebateResult, ResearchDecision, TradingPlan, RiskArgument, RiskDebateResult, RiskAssessment, FullAnalysisResult) |
| `src/orchestrator.ts` | Extract `runAnalystPhase()`, add `runFullAnalysis()` |
| `src/index.ts` | Register `trading_full` tool calling `runFullAnalysis()` |
| `src/report-store.ts` | Add full mode save with debate/research/trader/risk subdirectories |
| `tests/ts/integration.test.ts` | Add full analysis integration test |
| `openclaw.plugin.json` | No changes needed (skills unchanged) |

---

## 6. ReportStore Extension

Full mode report layout:

```
{report_dir}/{ticker}/{date}_full.json          — summary
{report_dir}/{ticker}/{date}_full/
  01_analysts/
    market.json
    fundamentals.json
    news.json
    sentiment.json
    policy.json
    hot_money.json
    lockup.json
  02_debate/
    round_1.json
    round_2.json
  03_research.json
  04_trading_plan.json
  05_risk/
    risk_debate.json
    risk_manager.json
```

`ReportStore.save()` signature extended: when `mode === "full"`, expects a `FullAnalysisResult` and writes the additional subdirectories.

---

## 7. Testing Strategy

### LLM call count

| Mode | Analysts | Debate | Research Mgr | Trader | Risk Debate | Risk Mgr | Total |
|------|----------|--------|-------------|--------|-------------|----------|-------|
| quick | 7 | 0 | 0 | 0 | 0 | 1 (PM) | 8 |
| full | 7 | 4 | 1 | 1 | 3 | 1 | 17 |

### Unit tests

Each stage module (`debate.ts`, `research-manager.ts`, `trader.ts`, `risk.ts`) gets its own test file with:
- Mock LLM responses (using `vi.mock` for OpenAI client)
- Verifying correct prompt rendering
- Verifying correct output structure
- Edge cases (empty claims, parse failures)

### Integration test

Extended `tests/ts/integration.test.ts`:
- Full `runFullAnalysis()` end-to-end with 17 mocked LLM calls
- Verify `FullAnalysisResult` complete structure
- Verify report files saved correctly in full mode layout
- Verify revise loop (mock Risk Manager to return revise once, then pass)

---

## 8. Trace Logging

Existing `TraceLogger` supports arbitrary phase/role. New phases use:

| Phase | Roles |
|-------|-------|
| `debate` | `bull`, `bear` |
| `research` | `research_manager` |
| `trader` | `trader` |
| `risk_debate` | `aggressive_risk`, `conservative_risk`, `neutral_risk` |
| `risk` | `risk_manager` |
