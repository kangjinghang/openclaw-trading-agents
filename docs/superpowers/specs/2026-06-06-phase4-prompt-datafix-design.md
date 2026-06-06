# Phase 4: Prompt VERDICT Fix + policy.py

**Date**: 2026-06-06
**Scope**: Fix VERDICT format in all prompt templates + implement missing policy.py data script

## Problem

### VERDICT Format Issue

End-to-end testing with weak models (glm-4-flash) revealed that prompt templates use ambiguous VERDICT instructions:

```
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

Weak models interpret `看多|看空|中性` as a template to copy, outputting the literal string `"看多|看空|中性"` instead of picking one value. This causes downstream parsing failures and degraded analysis quality.

Affected files (14 total):
- 7 analyst prompts: `analysts/market.md`, `analysts/fundamentals.md`, `analysts/news.md`, `analysts/sentiment.md`, `analysts/policy.md`, `analysts/hot_money.md`, `analysts/lockup.md`
- 1 portfolio manager: `portfolio_manager.md`
- 2 debate prompts: `debate/bull_researcher.md`, `debate/bear_researcher.md`
- 1 research manager: `debate/research_manager.md`
- 1 trader: `debate/trader.md`
- 1 risk debater: `debate/risk_debater.md`
- 1 risk manager: `debate/risk_manager.md`

### Missing policy.py

The `skills/trading-policy/scripts/policy.py` script is referenced in the orchestrator but does not exist. The policy analyst always receives no data, forcing the LLM to guess.

## Design

### Part 1: VERDICT Format Fix

#### Template Pattern

Replace the ambiguous VERDICT instruction pattern in all prompt templates.

**Before** (ambiguous):
```
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "简洁的一句话理由"} -->
```

**After** (explicit):

For analyst prompts (7 files), add at the end of each prompt:

```markdown
## 输出格式要求

在报告最后一行输出以下格式的机器可读结论。direction 字段只能填写一个值。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "估值合理且业绩增长"} -->

错误示例（禁止）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

For portfolio_manager.md, research_manager.md, trader.md — same pattern but with English directions:

```markdown
## 输出格式要求

在报告最后一行输出以下格式的机器可读结论。direction 字段只能填写一个值。

正确示例：
<!-- VERDICT: {"direction": "Buy", "reason": "估值合理且业绩增长"} -->
```

For bull/bear researcher prompts — fixed single direction:

```markdown
## 输出格式要求

在报告最后一行输出以下格式的机器可读结论。

<!-- VERDICT: {"direction": "看多", "reason": "一句话核心理由"} -->
```

For risk_debater.md and risk_manager.md:

```markdown
## 输出格式要求

在报告最后一行输出以下格式的机器可读结论。direction 字段只能填写一个值。

正确示例：
<!-- VERDICT: {"direction": "pass", "reason": "风险可控"} -->
```

#### Changes per file

1. **analysts/market.md** — Replace VERDICT line, add format section, directions: 看多/看空/中性
2. **analysts/fundamentals.md** — Same pattern
3. **analysts/news.md** — Same pattern
4. **analysts/sentiment.md** — Same pattern
5. **analysts/policy.md** — Same pattern
6. **analysts/hot_money.md** — Same pattern
7. **analysts/lockup.md** — Same pattern
8. **portfolio_manager.md** — Replace VERDICT line, add format section, directions: Buy/Overweight/Hold/Underweight/Sell
9. **debate/bull_researcher.md** — Replace VERDICT line, add format section, fixed direction: 看多
10. **debate/bear_researcher.md** — Same but fixed direction: 看空
11. **debate/research_manager.md** — Replace VERDICT line, add format section, directions: Buy/Overweight/Hold/Underweight/Sell
12. **debate/trader.md** — Same
13. **debate/risk_debater.md** — Replace VERDICT line, add format section, directions: pass/revise/reject
14. **debate/risk_manager.md** — Same

### Part 2: policy.py Implementation

#### Data Source

Use the following free APIs to fetch A-share policy events:

1. **财联社 (CLS) 电报 API** — `https://www.cls.cn/api/sw` — Returns real-time financial policy telegrams
2. **东方财富政策日历** — `https://datacenter.eastmoney.com/api/data/v1/get` — Policy calendar events

#### Output Format

Follow the same JSON contract as other scripts:

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "date": "2026-06-05",
    "policy_events": [
      {
        "date": "2026-06-01",
        "title": "人民银行降准0.25个百分点",
        "source": "人民银行",
        "impact": "positive",
        "relevance": "medium"
      }
    ],
    "macro_policies": [
      {
        "type": "monetary",
        "direction": "easing",
        "detail": "降准释放流动性"
      }
    ]
  }
}
```

#### Implementation

- Accept `--ticker` and `--date` args (consistent with other scripts)
- Try CLS API first, fallback to Eastmoney policy calendar
- Filter results by date range (lookback 7 days)
- Return structured JSON on stdout
- Error handling: return `{"success": false, "error": "..."}` on failure

## Testing

1. **Unit test**: Verify `parseVerdict()` correctly parses fixed VERDICT format (no change needed — existing code handles single-value directions)
2. **Unit test**: Verify `parseDirection()` handles the directions correctly (already covered)
3. **Manual e2e**: Re-run `trading_full` with glm-4-flash and verify all 7 analysts output valid single-value VERDICTs
4. **Script test**: Run `python3 skills/trading-policy/scripts/policy.py --ticker 600519 --date 2026-06-05` and verify JSON output

## Scope Exclusion

- NOT changing the pipeline architecture
- NOT adding new analyst roles
- NOT modifying TypeScript source files (only prompt templates + new Python script)
- NOT adding new npm dependencies
