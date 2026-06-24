# AGENTS.md

## Commands

```bash
npm install                         # Node dependencies
pip install -r requirements.txt     # Python deps: mootdx, akshare, pandas, requests
npm run build                       # tsc → dist/
npm test                            # vitest run (tests/ts/ *.test.ts)
npm run test:watch                  # vitest in watch mode
npm run coverage                    # vitest run --coverage
npm run lint                        # eslint src/
npx tsc --noEmit                    # typecheck (pass = no output)
node dist/cli.js                    # standalone CLI: quick|full <ticker> [date] [options]
node dist/dashboard.js              # HTTP dashboard on port 3210
```

**Order matters**: `build` before `test` — tests import from `dist/`.

Run a single test file:
```bash
npx vitest run tests/ts/orchestrator_pipeline.test.ts
```

Python (for data scripts):
```bash
bash scripts/setup-python.sh  # creates .venv, installs skill deps
source .venv/bin/activate
```

The plugin **auto-detects** a Python with `requests` installed (system, Homebrew, pyenv). Override: `TRADING_PYTHON=/path/to/python3`.

**Pre-commit** (husky → lint-staged): eslint --fix then tsc --noEmit on `src/**/*.ts`. Fix before committing.

## Architecture

OpenClaw plugin (`openclaw.plugin.json`) with 3 tools:
- `trading_quick` — 8 LLM calls (7 analysts → Portfolio Manager)
- `trading_full` — 15+ LLM calls (7 analysts → Bull↔Bear debate → Research → Trader → Risk debate → Risk Manager)
- `trading_report` — read-only query of saved reports

**Data flow** (`src/orchestrator.ts`):
1. Spawn 8 Python scripts in parallel (graceful degradation on failure)
2. Render prompt templates (`.md` with `{{key}}` placeholders), detect unresolved placeholders (skip that analyst)
3. 7 parallel LLM analyst calls with stagger jitter (0-800ms), default concurrency 3
4. Quality gate (deterministic Layer-1 + optional LLM Layer-2 credibility review)
5. Mode-specific downstream: PM (quick) OR debate → research → trader → risk (full)

**Rebalancer → QMT 执行桥** (`src/rebalance-cli.ts` + `src/watchlist/execution-bridge.ts`)：rebalancer 产出带 `order_id` + `execution:pending` + `execution_sequence` 的 `last_rebalance.json`，`syncPush` 推到 trading-state private repo；Win 云服务器的 QMT 执行器（Python + xtquant，独立项目）消费下单并字段级合并回写 holdings。Mac 开发机零依赖 xtquant。见 `docs/superpowers/specs/2026-06-25-qmt-execution-bridge-design.md`。

**Entrypoints**: `src/index.ts` (plugin), `src/cli.ts` (standalone binary `trading-agents`).

**`dist/` is committed** to git — `openclaw plugins install` needs the prebuilt artifact. Developers rebuild after TS changes and commit updated `dist/`.

## Key files

| File | Role |
|------|------|
| `src/types.ts` | All interfaces: config, analyst/debate/risk reports, quality, provenance |
| `src/orchestrator.ts` | Pipeline: `runQuickAnalysis()`, `runFullAnalysis()`, shared `runAnalystPhase()` |
| `src/llm-client.ts` | `callLLM()` wraps OpenAI, tracks tokens/cost. `parseVerdict()` extracts `<!-- VERDICT: {...} -->` from LLM output |
| `src/exec-python.ts` | Spawns `python3`; auto-resolves Python binary; caches results (`~/.openclaw/cache`, TTL 4h); 30s timeout |
| `src/prompt-loader.ts` | Loads `.md` templates, replaces `{{key}}` — missing keys left as-is (detected by `\|\|(\w+)\|\|` check in orchestrator) |
| `src/quality-gate.ts` | Deterministic Layer-1: empty/short/failure-marker/field-citation checks; A-F grading |
| `src/quality-review.ts` | Optional LLM Layer-2: catches fabrication, stale data, internal inconsistency via `<!-- QUALITY_REVIEW: {...} -->` |
| `src/pipeline-health.ts` | Runtime issue collector: abort/skip/warn severity; `hasAbort` stops pipeline |
| `src/cross-stage-checks.ts` | Post-pipeline structural anomaly detection (wrong-side target, consensus conflict, conservative overruled) |
| `src/debate.ts` / `research-manager.ts` / `trader.ts` / `risk.ts` | Full-mode phases via `<!-- DEBATE_STATE: {...} -->`, `<!-- RISK_JUDGE: {...} -->` protocols |
| `src/watchlist/order-id.ts` | `computeOrderId()` 幂等键（date+sha256(actions) 前 6 位），让 QMT 执行器识别已执行订单 |
| `src/watchlist/execution-schema.ts` | Execution 状态机：`isTerminal`/`isPending`/`makePendingExecution` |
| `src/watchlist/holdings-merge.ts` | `mergeHoldings()` 持仓字段级合并契约（QMT 市场字段覆盖，本地 sector 保留） |
| `src/watchlist/execution-bridge.ts` | `syncPush()` 推状态到 trading-state repo + 冲突仲裁（pending 撞已执行 → 拒绝） |

## Skills & Prompts

- 7 analyst skills + sector skill (8 data scripts), each under `skills/*/scripts/`
- **news and policy share the same script** (`skills/trading-news/scripts/news.py`) with different `--lookback-days` (7 vs 14) and different prompt templates
- Prompt templates: `skills/trading-analysis/prompts/`:
  - `analysts/{role}.md` — 7 analyst prompts
  - `portfolio_manager.md`, `quality_review.md`
  - `debate/{bull,bear}_researcher.md`, `research_manager.md`, `trader.md`, `risk_debater.md`, `risk_manager.md`
- Template variables split for news/sentiment: news gets `{{stock_news}}` + `{{macro_news}}`, sentiment gets `{{sentiment_data}}` (not the raw `{{sentiment}}` key)

## VERDICT & Structured Output Protocol

LLM outputs embed structured verdicts as HTML comments:

| Protocol | Parse function | Direction values |
|----------|---------------|-----------------|
| `<!-- VERDICT: {"direction":"...","reason":"..."} -->` | `parseVerdict()` in `llm-client.ts` | Analysts: `看多`/`看空`/`中性`; PM/Research/Trader: `Buy`/`Overweight`/`Hold`/`Underweight`/`Sell`; Risk: `pass`/`revise`/`reject` |
| `<!-- DEBATE_STATE: {...} -->` | `llm-client.ts` | Debate claim tracking (round, resolved, unresolved IDs) |
| `<!-- RISK_JUDGE: {...} -->` | `llm-client.ts` | Risk constraints: `hard_constraints`, `soft_constraints`, `execution_preconditions` |
| `<!-- QUALITY_REVIEW: {...} -->` | `parseQualityReview()` in `quality-review.ts` | Credibility: `高`/`中`/`低` |

`parseDirection()` in `orchestrator.ts` normalizes Chinese/English directions → `Buy`/`Hold`/`Sell`, handles pipe-separated fallback (takes first option).

## Testing

- **TypeScript**: Vitest (globals enabled, node env) in `tests/ts/`. All external calls mocked (LLM, Python, filesystem). No real API keys needed.
- **Python**: `pytest` in `tests/scripts/` (separate from vitest). Run via `python -m pytest tests/scripts/`.
- Integration: `tests/ts/integration.test.ts` covers full pipeline with mocks.

## Config

`TradingAgentsConfig` fields (`src/types.ts`, defaults in `src/index.ts`):
- `models.analyst/debater/decision/risk` — model per role (default: `glm-5-turbo`/`glm-5.2`)
- `models.decision_deep` — stronger model for research manager + risk manager gatekeepers (default: `glm-5.2`, falls back to `decision`/`risk`)
- `debate_rounds` (2), `risk_debate_rounds` (1), `max_risk_retries` (1)
- `report_dir` (`~/.openclaw/trading-reports`), `llm_concurrency` (3)

Plugin config file: `~/.openclaw/plugins/trading-agents/config.json`. Standalone CLI: `node dist/cli.js quick 600519 --model gpt-4o --debate-rounds 3`.

## Environment

- `OPENAI_API_KEY` — required (runtime only; tests are stubbed)
- `OPENAI_BASE_URL` — optional, for OpenAI-compatible APIs (ZhiPu, DeepSeek, etc.)
- Python 3.11+ with mootdx, akshare, pandas, requests
- Reports saved to `~/.openclaw/trading-reports/{ticker}/{date}_{mode}.json` + detail directory with phase subdirs (01_analysts/, 02_debate/, etc.)
- LLM traces: `{detailDir}/06_traces/{runId}/` — one JSON file per LLM call
- Data cache: `~/.openclaw/cache/` — 4h TTL, keyed by script path + args hash

## Conventions

- TypeScript strict mode, ES2020, CommonJS, declaration + source maps
- ESLint (typescript-eslint): `no-unused-vars` (warn), `no-explicit-any` (warn) — no Prettier
- Python scripts output JSON to stdout, errors to stderr
- Data scripts use mootdx (primary) + akshare (fallback) for A-share data
- K-line completeness check: min 50 bars; freshness fail if latest bar >7 days from analysis date (near-term only)
- CI: Node 20/22 on ubuntu-latest, runs build → test (with coverage) → lint → tsc --noEmit
