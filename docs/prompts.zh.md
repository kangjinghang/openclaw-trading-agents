# Prompt 设计

[English](prompts.md) | 中文

OpenClaw Trading Agents 的 Agent 角色与 Prompt 设计。所有 Prompt 均为 Markdown 模板，使用 `{{placeholder}}` 变量语法，存储在 `skills/trading-analysis/prompts/`。

## 角色总览

| 角色 | 文件 | 来源 | 关键设计 |
|------|------|------|---------|
| 技术分析师 | `analysts/market.md` | astock | A 股规则：T+1、涨跌停(±10%/±20%)、北向、量价分析 |
| 基本面分析师 | `analysts/fundamentals.md` | astock | CAS 会计准则、A 股 PE 区间（30-50x 常态） |
| 新闻分析师 | `analysts/news.md` | astock | 来源权重：财联社 > 新华财经 > 东方财富/同花顺。政策敏感度框架 |
| 情绪分析师 | `analysts/sentiment.md` | astock | 散户主导市场（>60%），反向指标，情绪一致性信号 |
| 政策分析师 | `analysts/policy.md` | astock | A 股"政策市"分析框架。A 股独有角色 |
| 游资追踪器 | `analysts/hot_money.md` | astock | 龙虎榜席位追踪、北向资金、主力资金流。A 股独有角色 |
| 解禁观察员 | `analysts/lockup.md` | astock | 限售解禁、减持计划、股权质押风险。A 股独有角色 |
| 投资组合经理 | `portfolio_manager.md` | astock | 综合 7 位分析师报告，输出最终方向 |
| 多头研究员 | `debate/bull.md` | AShare | Claim-based 结构化论证 |
| 空头研究员 | `debate/bear.md` | AShare | 反方论证 + 证据追踪 |
| 研究经理 | `debate/research_manager.md` | AShare | 5 级评分（Buy/Overweight/Hold/Underweight/Sell）、预期差分析 |
| 交易员 | `debate/trader.md` | astock | A 股执行计划：T+1、涨跌停、最小手数（100/200）、交易时段 |
| 风控辩论 | `debate/risk_debate.md` | astock | 三方视角：激进、保守、中性 |
| 风控经理 | `debate/risk_manager.md` | AShare | pass/revise/reject 路由 + 硬/软约束 |

## 模板变量

### 分析师 Prompt

| 分析师 | 变量 |
|--------|------|
| 技术分析师 | `{{ticker}}`, `{{date}}`, `{{kline}}` |
| 基本面分析师 | `{{ticker}}`, `{{date}}`, `{{fundamentals}}`, `{{financials}}` |
| 新闻分析师 | `{{ticker}}`, `{{date}}`, `{{news}}`, `{{global_news}}` |
| 情绪分析师 | `{{ticker}}`, `{{date}}`, `{{news}}` |
| 政策分析师 | `{{ticker}}`, `{{date}}`, `{{news}}`, `{{global_news}}` |
| 游资追踪器 | `{{ticker}}`, `{{date}}`, `{{fund_flow}}`, `{{northbound}}`, `{{dragon_tiger}}`, `{{hot_stocks}}` |
| 解禁观察员 | `{{ticker}}`, `{{date}}`, `{{insider}}`, `{{lockup}}` |

### 辩论/决策 Prompt

| 角色 | 变量 |
|------|------|
| 投资组合经理 | `{{ticker}}`, `{{date}}`, `{{analyst_reports}}` |
| 多头/空头 | `{{analyst_reports}}`, `{{debate_history}}` |
| 研究经理 | `{{analyst_reports}}`, `{{bull_final}}`, `{{bear_final}}` |
| 交易员 | `{{research_plan}}`, `{{ticker}}`, `{{date}}` |
| 风控辩论 | `{{trade_plan}}`, `{{analyst_reports}}`, `{{debate_result}}` |
| 风控经理 | `{{trade_plan}}`, `{{risk_arguments}}` |

## A 股特有 Prompt 设计

### 3 个独有分析师角色

A 股市场有独特性，需要专门的分析角色：

- **政策分析师**：A 股受政策影响极大。此角色追踪货币政策、监管变化、行业扶持/限制、中美关系等。
- **游资追踪器**：追踪龙虎榜席位动向、北向资金（沪股通/深股通）、主力资金流 — A 股特有的资金面分析。
- **解禁观察员**：监控限售股解禁时间表、大股东减持计划、股权质押风险。

### A 股交易约束（交易员 Prompt）

```
- T+1 交割：当日买入，次日才能卖出
- 涨跌停：主板 ±10%，科创板/创业板 ±20%，ST ±5%
- 最小手数：主板 100 股，科创板/创业板 200 股
- 交易时段：09:30-11:30, 13:00-15:00 北京时间
```

### 风控辩论三方视角

| 视角 | 偏好 | 核心论点 |
|------|------|---------|
| 激进 | 涨停板效应、政策底、PE 扩张 | 动量、北向确认、散户羊群 |
| 保守 | T+1 锁定风险、跌停陷阱、政策反转 | 股权质押风险、资金流出、PE>50x+PEG>2 |
| 中性 | T+1 双刃剑、估值区间法 | 仓位管理优先、平衡风险评估 |

## VERDICT 格式

所有 Prompt 指导 LLM 在输出末尾包含结构化结论：

```markdown
## 机器可读结论

在报告的最后一行，必须包含以下格式的机器可读结论。`direction` 字段只能填写一个值，禁止填写多个。

正确示例：
<!-- VERDICT: {"direction": "看多", "reason": "估值合理，盈利稳定增长"} -->

错误（禁止这样输出）：
<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->
```

明确给出正确/错误示例，防止弱模型直接复制选项列表。
