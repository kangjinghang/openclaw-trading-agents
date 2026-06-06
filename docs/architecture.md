# Architecture

English | [中文](architecture.zh.md)

System architecture and design of OpenClaw Trading Agents.

## Overview

OpenClaw Trading Agents is an [OpenClaw](https://github.com/openclaw/openclaw) plugin that orchestrates multiple AI agents to analyze China A-share stocks. The system has two analysis modes:

- **Quick mode** (`trading_quick`): 7 analysts → Portfolio Manager. 8 LLM calls.
- **Full mode** (`trading_full`): 7 analysts → Bull↔Bear debate → Research Manager → Trader → 3-way risk debate → Risk Manager. 15+ LLM calls.

## Data Flow

```
User → OpenClaw Tool Call
  ↓
┌─ Data Preparation (7 Python scripts, parallel) ──────────────┐
│  kline · fundamentals · news · sentiment · policy             │
│  hot_money · lockup · sector                                  │
└───────────────────────────────────────────────────────────────┘
  ↓
┌─ Quick Mode (8 LLM calls) ──────────────────────────────────┐
│  7 Analysts (parallel) → Portfolio Manager                    │
│  Output: QuickAnalysisResult                                  │
└──────────────────────────────────────────────────────────────┘
  ↓ (or)
┌─ Full Mode (15+ LLM calls) ─────────────────────────────────┐
│  Stage 1: 7 Analysts (parallel)                               │
│  Stage 2: Bull↔Bear Debate (N rounds, default 2)             │
│  Stage 3: Research Manager (5-tier scoring)                   │
│  Stage 4: Trader (A-share execution plan)                     │
│  Stage 5: 3-way Risk Debate + Risk Manager                    │
│  Output: FullAnalysisResult                                   │
└──────────────────────────────────────────────────────────────┘
  ↓
Report Persistence + LLM Trace Logging
```

## Layered Design

| Layer | Tech | Change Frequency | Purpose |
|-------|------|-----------------|---------|
| Plugin | TypeScript | Low | Register tools, orchestrate pipeline, call LLM API |
| Skills | Python | Medium | Data fetching scripts with fallback logic |
| Prompts | Markdown | Medium | Role prompt templates with `{{placeholder}}` variables |

## Components

### Plugin Layer (`src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point. Registers `trading_quick`, `trading_full`, `trading_report` tools. |
| `orchestrator.ts` | Pipeline coordination. `runQuickAnalysis()` and `runFullAnalysis()`. |
| `llm-client.ts` | OpenAI-compatible API wrapper with cost tracking. `parseVerdict()` extracts structured conclusions from LLM output. |
| `exec-python.ts` | Spawns Python child processes with 30s timeout. Returns `ScriptResult` (JSON stdout or error). |
| `prompt-loader.ts` | Loads `.md` templates and replaces `{{key}}` placeholders with data. |
| `report-store.ts` | Persists JSON reports to disk. `save()` for quick, `saveFull()` for full mode. |
| `trace-logger.ts` | Writes per-call LLM traces for auditing. |
| `debate.ts` | Bull↔Bear multi-round adversarial debate. |
| `research-manager.ts` | Scores debate arguments, produces 5-tier direction decision. |
| `trader.ts` | Generates A-share execution plan (T+1, price limits, lot sizes). |
| `risk.ts` | 3-way risk debate (aggressive/conservative/neutral) + Risk Manager with pass/revise/reject flow. |
| `types.ts` | All TypeScript interfaces. |

### Skills Layer (`skills/`)

Each skill is a self-contained data domain with a Python script and optional fallback:

| Skill | Data | Primary Source | Fallback |
|-------|------|---------------|----------|
| `trading-kline` | K-line OHLCV | mootdx (TDX TCP) | akshare (Sina HTTP) |
| `trading-fundamentals` | PE/PB/ROE/Financials | Tencent Finance / Eastmoney | mootdx F10 |
| `trading-news` | Stock news + Macro news | CLS / Eastmoney | — |
| `trading-sentiment` | Market sentiment | Eastmoney | — |
| `trading-policy` | Policy events | Eastmoney search / CLS | — |
| `trading-hot-money` | Northbound/Fund flow/Dragon-Tiger | Eastmoney | akshare |
| `trading-lockup` | Lockup expiry/Insider trading | Eastmoney / mootdx F10 | akshare |
| `trading-sector` | Industry ranking/Concept blocks | Eastmoney / Baidu | akshare |

### Prompt Layer (`skills/trading-analysis/prompts/`)

16 role prompt templates organized in two subdirectories:

```
prompts/
├── analysts/                    # 7 analyst roles
│   ├── market.md               # Technical analysis (A-share rules: T+1, price limits)
│   ├── fundamentals.md         # CAS accounting, A-share valuation
│   ├── news.md                 # News with source weighting (CLS > Eastmoney)
│   ├── sentiment.md            # Sentiment with contrarian indicators
│   ├── policy.md               # A-share "policy market" analysis (unique)
│   ├── hot_money.md            # Dragon-Tiger board/Northbound/Main force flow (unique)
│   └── lockup.md               # Lockup expiry/Share reduction (unique)
├── portfolio_manager.md        # Synthesizes 7 analyst reports
└── debate/                     # 6 debate/research/trading/risk roles
    ├── bull.md                 # Bull researcher (claim-based argumentation)
    ├── bear.md                 # Bear researcher
    ├── research_manager.md     # 5-tier scoring + direction decision
    ├── trader.md               # A-share execution plan (T+1, price limits, lot sizes)
    ├── risk_debate.md          # 3-way risk: aggressive/conservative/neutral
    └── risk_manager.md         # pass/revise/reject with hard/soft constraints
```

Templates use `{{placeholder}}` syntax. The `prompt-loader.ts` module replaces placeholders with actual data at runtime.

## VERDICT Protocol

All LLM outputs embed a structured conclusion as an HTML comment:

```html
<!-- VERDICT: {"direction": "看多", "reason": "估值合理，盈利稳定增长"} -->
```

Direction values vary by stage:

| Stage | Direction Values |
|-------|-----------------|
| Analysts | `看多` / `看空` / `中性` |
| Bull/Bear Debate | `看多` / `看空` |
| Research Manager | `Buy` / `Overweight` / `Hold` / `Underweight` / `Sell` |
| Trader | `Buy` / `Hold` / `Sell` |
| Risk | `pass` / `revise` / `reject` |

The `parseDirection()` helper in `orchestrator.ts` maps Chinese/English direction names to canonical `Buy`/`Hold`/`Sell`. It also handles pipe-separated values (e.g. `看多|看空|中性`) as a defensive fallback.

## Revise Loop

In full mode, the Risk Manager can return:
- **pass**: Plan approved, proceed to final output.
- **revise**: Send hard constraints back to Trader for re-generation (max 1 retry).
- **reject**: Output "do not trade" recommendation.

## Report Storage

Reports are saved under `report_dir` (default: `~/.openclaw/trading-reports/`):

```
report_dir/
├── 600519/
│   ├── 2026-06-05_quick.json              # Quick mode summary
│   ├── 2026-06-05_full.json               # Full mode summary
│   └── 2026-06-05_full/
│       ├── 01_analysts/
│       │   └── market.json                # Each analyst's report
│       ├── 02_debate/
│       │   ├── round_1.json
│       │   └── round_2.json
│       ├── 03_research.json
│       ├── 04_trading_plan.json
│       └── 05_risk/
│           ├── aggressive.json
│           ├── conservative.json
│           ├── neutral.json
│           └── risk_manager.json
```

LLM traces are stored in `~/.openclaw/traces/<ticker>_<date>/` with one JSON file per LLM call, recording the complete input/output for auditing.

## Configuration

```json
{
  "models": {
    "analyst": "gpt-4o",
    "debater": "gpt-4o",
    "decision": "gpt-4o",
    "risk": "gpt-4o"
  },
  "debate_rounds": 2,
  "risk_debate_rounds": 1,
  "max_risk_retries": 1,
  "report_dir": "~/.openclaw/trading-reports"
}
```

Any OpenAI-compatible API is supported. Different models can be assigned to different stages (e.g. cheaper model for analysts, stronger model for debate).

## Customization

| What to change | Where to edit |
|---------------|---------------|
| Data API changed | `skills/trading-*/scripts/*.py` |
| Add new data source | Create new Skill + update `openclaw.plugin.json` |
| Adjust analyst prompt | `skills/trading-analysis/prompts/analysts/*.md` |
| Adjust debate prompt | `skills/trading-analysis/prompts/debate/*.md` |
| Modify pipeline flow | `src/orchestrator.ts` |
| Add new tool | `src/index.ts` register new tool |
| Change LLM model | config.json |
