---
name: edit-prompt-template
description: "Edit LLM prompt templates with validation. Handles reading, modifying, and verifying prompt files in skills/trading-analysis/prompts/."
---

# Edit Prompt Template

Edit LLM prompt templates used by the trading analysis pipeline. Prompt templates are in `skills/trading-analysis/prompts/` and use `{{placeholder}}` syntax.

## Trigger

User says "修改 prompt", "edit prompt", "update template", "改提示词", or mentions editing analyst/portfolio-manager/debate prompts.

## Procedure

### Step 1: Identify the prompt file

Prompt files are organized in `skills/trading-analysis/prompts/`:

**Analyst prompts** (in `analysts/` subdirectory):
- `fundamentals.md` — Fundamentals analyst prompt
- `hot_money.md` — Hot money flow analyst prompt
- `lockup.md` — Lockup analyst prompt
- `market.md` — Market analyst prompt (most frequently edited)
- `news.md` — News analyst prompt
- `policy.md` — Policy analyst prompt
- `sentiment.md` — Sentiment analyst prompt

**Other prompts** (in root directory):
- `portfolio_manager.md` — Portfolio manager decision prompt
- `quality_review.md` — Quality review prompt

**Debate prompts** (in `debate/` subdirectory):
- `bear_researcher.md` — Bear researcher prompt
- `bull_researcher.md` — Bull researcher prompt
- `research_manager.md` — Research manager prompt
- `risk_debater.md` — Risk debater prompt
- `risk_manager.md` — Risk assessment prompt
- `trader.md` — Trader execution prompt

Use Glob to find the exact file:
```bash
ls skills/trading-analysis/prompts/
ls skills/trading-analysis/prompts/analysts/
ls skills/trading-analysis/prompts/debate/
```

### Step 2: Read the current template

```bash
Read <file_path>
```

Key things to check:
- `{{placeholder}}` syntax is preserved
- VERDICT protocol format is correct
- No broken markdown formatting
- Chinese/English text consistency

### Step 3: Make targeted edits

Use Edit tool with specific `oldString` and `newString`:
```
Edit file_path=<path> oldString="<exact text>" newString="<new text>"
```

**Critical rules:**
1. Always preserve `{{placeholder}}` syntax — these are rendered by `src/prompt-loader.ts`
2. Keep VERDICT protocol format: `<!-- VERDICT: {"direction": "...", "reason": "..."} -->`
3. Maintain consistent language (Chinese or English)
4. Test placeholders must match what's in `src/types.ts`

### Step 4: Verify template syntax

After editing, verify:
1. No broken `{{` or `}}` syntax
2. All placeholders are properly closed
3. Markdown formatting is valid

```bash
# Check for unclosed placeholders
grep -n "{{" <file_path> | grep -v "}}"

# Check for VERDICT protocol
grep -n "VERDICT" <file_path>
```

### Step 5: Run relevant tests

If the prompt is used by specific analysts, run their tests:
```bash
# For analyst prompts
npx vitest run tests/ts/prompts_contract.test.ts

# For specific modules
npx vitest run tests/ts/trader.test.ts
npx vitest run tests/ts/risk.test.ts
npx vitest run tests/ts/debate.test.ts
```

### Step 6: Build and verify

```bash
npm run build 2>&1 | tail -5
```

Ensure no TypeScript errors from prompt changes.

## Common Prompt Patterns

### Analyst Prompts
- Role definition: "You are a [role] analyst..."
- Data context: `{{ANALYST_DATA}}`, `{{FUNDAMENTALS}}`, `{{KLINES}}`
- Output format: Structured JSON with specific fields
- VERDICT protocol: Direction + confidence + reasoning

### Portfolio Manager Prompt
- Input: Multiple analyst reports
- Decision framework: Weight allocation
- VERDICT: Buy/Hold/Sell with target price

### Debate Prompt
- Input: Conflicting analyst views
- Process: Counter-arguments, evidence weighing
- Output: Resolved consensus

## Placeholder Reference

Common placeholders (from prompt templates):
- `{{ticker}}` — Stock ticker (e.g., "600519")
- `{{company_info}}` — Company information
- `{{date}}` — Analysis date
- `{{kline}}` — K-line data
- `{{data_quality}}` — Data quality information
- `{{vpa}}` — Volume price analysis data
- `{{technical_indicators}}` — Technical indicators
- `{{fundamentals}}` — Fundamentals data
- `{{news}}` — News data
- `{{sentiment}}` — Sentiment data
- `{{hot_money}}` — Hot money flow data
- `{{lockup}}` — Lockup data
- `{{policy}}` — Policy data

## Example

```bash
# User: "修改市场分析师提示词，增加成交量分析"
Read skills/trading-analysis/prompts/analysts/market.md
Edit file_path=skills/trading-analysis/prompts/analysts/market.md \
  oldString="Analyze the stock based on price and volume" \
  newString="Analyze the stock based on price, volume, and trading activity"
npx vitest run tests/ts/prompts_contract.test.ts
npm run build 2>&1 | tail -3
```

## Failure Modes

1. **Broken placeholders** → Template rendering fails at runtime
2. **Invalid VERDICT format** → Parsing fails in `src/llm-client.ts`
3. **Inconsistent language** → LLM output quality degrades
4. **Missing test updates** → Contract tests may fail
