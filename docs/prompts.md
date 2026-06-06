# Prompts

English | [中文](prompts.zh.md)

Agent roles and prompt design for OpenClaw Trading Agents. All prompts are Markdown templates with `{{placeholder}}` variables, stored in `skills/trading-analysis/prompts/`.

## Role Overview

| Role | File | Source | Key Design Decisions |
|------|------|--------|---------------------|
| Technical Analyst | `analysts/market.md` | astock | A-share rules: T+1, price limits (±10%/±20%), northbound, volume-price analysis |
| Fundamentals Analyst | `analysts/fundamentals.md` | astock | CAS accounting standards, A-share PE range (30-50x normal) |
| News Analyst | `analysts/news.md` | astock | Source weighting: CLS > Xinhua > Eastmoney/10jqka. Policy sensitivity framework |
| Sentiment Analyst | `analysts/sentiment.md` | astock | Retail-dominated market (>60%), contrarian indicators, emotional consistency signals |
| Policy Analyst | `analysts/policy.md` | astock | A-share "policy market" analysis. Unique to A-share market |
| Hot Money Tracker | `analysts/hot_money.md` | astock | Dragon-Tiger board, northbound capital, main force flow. Unique to A-share market |
| Lockup Watcher | `analysts/lockup.md` | astock | Lockup expiry, share reduction, margin pledge. Unique to A-share market |
| Portfolio Manager | `portfolio_manager.md` | astock | Synthesizes 7 analyst reports into final direction |
| Bull Researcher | `debate/bull.md` | AShare | Claim-based structured argumentation |
| Bear Researcher | `debate/bear.md` | AShare | Counter-argumentation with evidence tracking |
| Research Manager | `debate/research_manager.md` | AShare | 5-tier scoring (Buy/Overweight/Hold/Underweight/Sell), expectation gap analysis |
| Trader | `debate/trader.md` | astock | A-share execution: T+1, price limits, minimum lots (100/200), trading hours |
| Risk Debate | `debate/risk_debate.md` | astock | 3 perspectives: aggressive, conservative, neutral |
| Risk Manager | `debate/risk_manager.md` | AShare | pass/revise/reject routing with hard/soft constraints |

## Template Variables

### Analyst Prompts

| Analyst | Variables |
|---------|-----------|
| Technical | `{{ticker}}`, `{{date}}`, `{{kline}}` |
| Fundamentals | `{{ticker}}`, `{{date}}`, `{{fundamentals}}`, `{{financials}}` |
| News | `{{ticker}}`, `{{date}}`, `{{news}}`, `{{global_news}}` |
| Sentiment | `{{ticker}}`, `{{date}}`, `{{news}}` |
| Policy | `{{ticker}}`, `{{date}}`, `{{news}}`, `{{global_news}}` |
| Hot Money | `{{ticker}}`, `{{date}}`, `{{fund_flow}}`, `{{northbound}}`, `{{dragon_tiger}}`, `{{hot_stocks}}` |
| Lockup | `{{ticker}}`, `{{date}}`, `{{insider}}`, `{{lockup}}` |

### Debate/Decision Prompts

| Role | Variables |
|------|-----------|
| Portfolio Manager | `{{ticker}}`, `{{date}}`, `{{analyst_reports}}` |
| Bull/Bear | `{{analyst_reports}}`, `{{debate_history}}` |
| Research Manager | `{{analyst_reports}}`, `{{bull_final}}`, `{{bear_final}}` |
| Trader | `{{research_plan}}`, `{{ticker}}`, `{{date}}` |
| Risk Debate | `{{trade_plan}}`, `{{analyst_reports}}`, `{{debate_result}}` |
| Risk Manager | `{{trade_plan}}`, `{{risk_arguments}}` |

## A-Share Specific Prompt Features

### 3 Unique Analyst Roles

A-share market has unique characteristics that require specialized analysis:

- **Policy Analyst**: A-share is heavily influenced by government policy. This role tracks monetary policy, regulatory changes, industry support/restriction, and US-China relations.
- **Hot Money Tracker**: Tracks dragon-tiger board (龙虎榜) seat movements, northbound capital (沪股通/深股通), and main force fund flows — patterns specific to A-share.
- **Lockup Watcher**: Monitors restricted share unlock schedules, insider reduction plans, and margin pledge risks.

### A-Share Trading Constraints (Trader Prompt)

```
- T+1 settlement: Buy today, can sell tomorrow
- Price limits: Main board ±10%, STAR/ChiNext ±20%, ST ±5%
- Minimum lot: 100 shares (main board) or 200 shares (STAR/ChiNext)
- Trading hours: 09:30-11:30, 13:00-15:00 Beijing time
```

### Risk Debate Perspectives

| Perspective | Biases | Key Arguments |
|-------------|--------|---------------|
| Aggressive | Limit-up effects, policy bottom, PE expansion | Momentum, northbound confirmation, retail herding |
| Conservative | T+1 lock risk, limit-down trap, policy reversal | Margin pledge risk, fund outflow, PE>50x+PEG>2 |
| Neutral | T+1 double-edged, valuation range method | Position sizing priority, balanced risk assessment |

## VERDICT Format

All prompts instruct the LLM to output a structured conclusion at the end of its response:

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "估值合理，盈利稳定增长"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

The explicit correct/incorrect examples prevent weak models from copying the option list verbatim.
