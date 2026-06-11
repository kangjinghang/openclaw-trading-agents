---
name: run-analysis
description: "Run a full or quick trading analysis for a stock ticker via CLI. Handles env var setup, build check, background execution, and progress monitoring."
---

# Run Analysis

Run a stock analysis (full or quick mode) using the CLI script.

## Trigger

User asks to run an analysis, test a stock, verify a fix, or re-run analysis for a ticker. Keywords: "跑", "run", "分析", "analyze", "测试", "verify" + ticker number.

## Procedure

### Step 1: Ensure dist/ is fresh

```bash
npm run build 2>&1 | tail -5
```

If build fails, fix errors before proceeding. **Critical**: stale `dist/` is the #1 cause of mysterious failures (template mismatch, missing fields).

### Step 2: Run analysis

Choose command based on mode:

**Full analysis** (default):
```bash
OPENAI_API_KEY=<key> OPENAI_BASE_URL=<url> TRADING_MODEL=<model> \
  node scripts/run-full-analysis.js <TICKER> full \
  > /tmp/full<TICKER>.log 2>&1
```

**Quick analysis**:
```bash
OPENAI_API_KEY=<key> OPENAI_BASE_URL=<url> TRADING_MODEL=<model> \
  node scripts/run-full-analysis.js <TICKER> quick \
  > /tmp/quick<TICKER>.log 2>&1
```

Run in background when possible (analysis takes 1-5 minutes depending on mode).

Default env vars (if user hasn't specified different ones):
- `OPENAI_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4`
- `TRADING_MODEL=GLM-5.1`
- `OPENAI_API_KEY` — ask user if not available in env

### Step 3: Monitor progress

```bash
sleep 10 && tail -20 /tmp/full<TICKER>.log
```

Check for completion signals:
- Full mode: look for `"direction"` in output, or `保存报告` log line
- Quick mode: look for `VERDICT` in output

### Step 4: Verify results

After completion, check the report was saved:
```bash
ls ~/.openclaw/trading-reports/<TICKER>/<DATE>_full/ 2>/dev/null || \
ls ~/.openclaw/trading-reports/<TICKER>/<DATE>_quick/ 2>/dev/null
```

Key outputs to verify:
- `04_trading_plan.json` — contains target_price, stop_loss, direction
- `06_traces/` — LLM call traces with token usage and cost

### Step 5: Report summary

Extract and present:
- Direction (Buy/Hold/Sell) and confidence
- Target price and stop loss
- Total LLM calls and cost
- Any pipeline health flags or warnings

## Common Failure Modes

1. **Stale dist/** → rebuild with `npm run build`
2. **Missing API key** → script exits with error message
3. **Python script timeout** → check `skills/trading-*/scripts/` dependencies
4. **Risk revise retry exhaustion** → not a bug, means risk manager couldn't approve; check traces

## Example

```bash
# User: "跑 600600 全量测试"
npm run build 2>&1 | tail -3
OPENAI_API_KEY=xxx OPENAI_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4 TRADING_MODEL=GLM-5.1 \
  node scripts/run-full-analysis.js 600600 full > /tmp/full600600.log 2>&1
# ... wait ...
tail -30 /tmp/full600600.log
```
