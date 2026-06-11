# AGENTS.md

## Commands

```bash
npm install                         # Node dependencies
pip install mootdx akshare requests # Python data-fetch deps
npm run build                       # tsc → dist/
npm test                            # vitest run (50+ tests in tests/ts/)
npm run lint                        # eslint src/
npx tsc --noEmit                    # typecheck (no output = pass)
npm run analyze                     # node dist/cli.js (quick/full commands)
npm run dashboard                   # node dist/dashboard.js
```

**Order matters**: `build` before `test` — tests import from `dist/`.

Run a single test file:
```bash
npx vitest run tests/ts/orchestrator_pipeline.test.ts
```

Python setup (for data scripts):
```bash
bash scripts/setup-python.sh  # creates .venv, installs skill requirements
source .venv/bin/activate
```

## Architecture

This is an OpenClaw plugin (`openclaw.plugin.json`) with 3 tools:
- `trading_quick` — 8 LLM calls (7 analysts → PM)
- `trading_full` — 15+ LLM calls (analysts → debate → research → trader → risk)
- `trading_report` — read-only query of saved reports

**Data flow**: TypeScript orchestrator (`src/orchestrator.ts`) spawns Python scripts (`skills/*/scripts/*.py`) as child processes, feeds their JSON output into LLM calls via `src/llm-client.ts`.

**Key directories**:
- `skills/trading-analysis/prompts/` — all LLM prompt templates (`.md` with `{{placeholder}}` syntax)
- `skills/*/scripts/` — Python data-fetchers (each outputs JSON to stdout)
- `skills/_shared/` — shared Python utilities (http_helpers.py)
- `src/` — TypeScript pipeline logic
- `tests/ts/` — vitest tests (mock LLM + Python; no real API calls)
- `tests/scripts/` — Python unit tests (pytest, separate from vitest)

## VERDICT Protocol

LLM outputs embed structured verdicts as HTML comments:
```
<!-- VERDICT: {"direction": "看多", "reason": "..."} -->
```
Parse with `parseVerdict()` in `src/llm-client.ts`. Direction values vary by phase:
- Analysts: `看多` / `看空` / `中性`
- Portfolio Manager: `Buy` / `Overweight` / `Hold` / `Underweight` / `Sell`
- Risk: `pass` / `revise` / `reject`

## Testing

- Tests mock all external calls (LLM API, Python processes, file system)
- `tests/scripts/` has Python unit tests (pytest, separate from vitest)
- No real API keys needed for tests — everything is stubbed
- `tests/ts/integration.test.ts` covers the full pipeline with mocks
- Vitest config: `vitest.config.ts` — globals enabled, node environment, `tests/ts/**/*.test.ts`

## Pre-commit

Husky runs `npx lint-staged` on commit:
- `src/**/*.ts` → `eslint --fix` then `tsc --noEmit`
- Fix lint/type errors before committing

## Environment

- `OPENAI_API_KEY` — required for runtime (not for tests)
- `OPENAI_BASE_URL` — optional, for compatible APIs (ZhiPu, DeepSeek, etc.)
- Python 3.11+ required for data scripts
- Data scripts use mootdx (primary) + akshare (fallback) for A-share data
- CI tests on Node 18, 20, 22 (ubuntu-latest)

## Conventions

- TypeScript strict mode, ES2020 target, CommonJS modules
- ESLint config: `eslint.config.js` — `@typescript-eslint/no-unused-vars: warn`, `@typescript-eslint/no-explicit-any: warn`
- No Prettier — rely on eslint --fix for formatting
- All LLM output parsing is in `src/llm-client.ts` — new verdict formats go there
- Prompt templates use `{{key}}` placeholders, rendered by `src/prompt-loader.ts`
- Python scripts output JSON to stdout, errors to stderr
- Reports saved to `~/.openclaw/trading-reports/{ticker}/{date}_{mode}.json`
