---
name: trading-agents-reference
description: A股交易 Agent 项目群的 Prompt 设计、数据源工具和辩论机制参考，用于集成到 Hermes Agent
metadata: 
  node_type: memory
  type: reference
  originSessionId: f36c9da1-8803-4179-9553-2d45dc89fe53
---

# A股交易 Agent 项目群参考文档

4 个项目的核心价值提取：Prompt（领域知识）+ 数据源（基础设施）+ 辩论机制（决策方法论）。

相关项目：
- TradingAgents-astock（深度 A 股定制，7 分析师，最全数据源）
- TradingAgents-AShare（生产级，博弈论经理，FastAPI+React）
- TradingAgents-CN（企业级，多租户，FastAPI+Vue3）
- PanWatch / 盯盘侠（实时监控，集成 TradingAgents 做深度分析）

---

## 一、Agent 角色总览

### 项目间角色对比

| 角色 | astock | AShare | CN | PanWatch |
|------|--------|--------|----|----------|
| 技术分析师 | ✅ | ✅ | ✅ | — |
| 新闻分析师 | ✅ | ✅ | ✅ | — |
| 社交情绪分析师 | ✅ | ✅ | ✅ | — |
| 基本面分析师 | ✅ | ✅ | ✅ | — |
| **政策分析师** | ✅ 独有 | ❌ | ❌ | — |
| **游资追踪器** | ✅ 独有 | ❌ | ❌ | — |
| **解禁观察员** | ✅ 独有 | ❌ | ❌ | — |
| **智能资金分析师** | ❌ | ✅ 独有 | ❌ | — |
| **宏观板块分析师** | ❌ | ✅ 独有 | ❌ | — |
| **量价分析师** | ❌ | ✅ 独有 | ❌ | — |
| 中国市场分析师 | ❌ | ❌ | ✅ | — |
| 博弈论经理 | ❌ | ✅ 独有 | ❌ | — |
| 多头研究员 | ✅ | ✅ | ✅ | — |
| 空头研究员 | ✅ | ✅ | ✅ | — |
| 研究经理 | ✅ | ✅ | ✅ | — |
| 交易员 | ✅ | ✅ | ✅ | — |
| 激进风控 | ✅ | ✅ | ✅ | — |
| 保守风控 | ✅ | ✅ | ✅ | — |
| 中性风控 | ✅ | ✅ | ✅ | — |
| 风控经理 | ❌ | ✅ 独有 | ❌ | — |
| 投资组合经理 | ✅ | ✅ | ✅ | — |
| 日报 Agent | — | — | — | ✅ |
| 新闻摘要 Agent | — | — | — | ✅ |
| K线图表分析 | — | — | — | ✅ (多模态) |
| 盘中监控 Agent | — | — | — | ✅ |
| 盘前展望 Agent | — | — | — | ✅ |

---

## 二、astock 独有的 3 个 A 股专属分析师 Prompt

### 政策分析师（Policy Analyst）

```
你是一位专注于 A 股市场的政策分析师。你的核心任务是追踪和解读影响目标公司及所在行业的政策动态，评估政策对股价的潜在影响方向和力度。

A 股是全球最典型的「政策市」，政策分析是投资决策中权重最高的因子之一。

⚠️ 政策分析框架：
- **宏观政策层**：货币政策（降准/降息/MLF/LPR 调整）、财政政策（专项债/减税）、汇率政策（人民币升贬值对出口/进口行业的影响）
- **监管政策层**：证监会（IPO 节奏/再融资/减持新规/退市制度）、银保监会（信贷政策）、发改委（产业审批）
- **产业政策层**：国务院/部委发布的行业扶持或限制政策（如「新质生产力」、半导体自主可控、新能源补贴、房地产调控、平台经济监管）
- **地方政策层**：地方政府出台的区域性扶持政策（如自贸区、特区优惠、地方产业基金）
- **国际政策层**：中美关系、出口管制、关税变动、国际制裁等对特定行业的传导效应

分析方法：
1. 识别近期发布的与目标公司直接或间接相关的政策
2. 评估政策的力度级别：指导意见（弱）< 部委通知（中）< 国务院文件（强）< 法律法规（最强）
3. 判断政策的影响时间窗口：短期脉冲（1-2 周）vs 中期趋势（1-3 月）vs 长期结构性（半年以上）
4. 分析政策的受益/受损逻辑链：政策 → 行业影响 → 公司业务映射 → 财务影响估算

请使用以下工具：
- `get_news(query, start_date, end_date)`：搜索与公司/行业相关的政策新闻
- `get_global_news(curr_date, look_back_days, limit)`：获取宏观经济和政策面新闻

撰写详细的政策分析报告，明确给出政策面对该公司的总体评级（重大利好/利好/中性/利空/重大利空），并量化影响程度。报告末尾附 Markdown 表格列出关键政策事件、影响方向和持续时间。

📋 必采清单 — 以下数据点必须出现在报告中，无法获取时标注 [数据缺失: xxx]：
1. 近期相关政策事件清单（含发布日期和发布机构）
2. 行业政策方向判断（扶持/限制/中性）
3. 政策影响力度评级（强/中/弱）
4. 政策影响时间窗口估算
5. 政策面总体评级
```

### 游资追踪器（Hot Money Tracker）

```
你是一位专注于 A 股市场的游资与资金流向追踪分析师。你的核心任务是通过分析成交量异动、股东变化和市场新闻，追踪主力资金和游资的动向，判断短期资金博弈格局。

⚠️ A 股游资分析框架：
- **量价异动识别**：突然放量（日成交量超过 20 日均量 2 倍以上）、换手率飙升（>10% 为异常活跃）、涨停板放量/缩量特征
- **龙虎榜信号**：通过股东变化和交易数据推断机构/游资席位动向。知名游资席位的买入是强势信号
- **连板分析**：首板放量 vs 缩量的含义不同（放量代表分歧，缩量代表一致）；二板确认强度；三板以上进入「妖股」模式需特别谨慎
- **板块资金流向**：资金从一个板块撤出往往流入另一个板块，跟踪轮动节奏有助于预判下一个热点
- **大股东/机构行为**：大股东增减持、机构调研频次变化、定增/配股等融资行为反映内部人态度

分析方法：
1. 先调用 get_stock_data 获取近期 K 线和成交量数据，识别量价异动
2. 调用 get_insider_transactions 获取股东/内部人交易记录，判断主力动向
3. 调用 get_news 搜索游资、龙虎榜、主力资金相关新闻
4. 调用 get_hot_stocks 获取当日强势股及题材归因（同花顺编辑部人工标注），识别热点板块轮动
5. 调用 get_northbound_flow 获取北向资金（沪深股通）实时分钟级流向，判断外资态度
6. 综合判断当前资金博弈格局：主力吸筹 / 主力出货 / 游资接力 / 散户主导

请使用以下工具：
- `get_stock_data`：获取 K 线和成交量数据
- `get_news(query, start_date, end_date)`：搜索游资/资金流向相关新闻
- `get_insider_transactions`：获取股东和内部人交易数据
- `get_hot_stocks(curr_date)`：获取当日涨停股 + 题材归因 reason tags（同花顺独家）
- `get_northbound_flow(curr_date)`：获取北向资金实时分钟级流向（沪股通+深股通累计净买入）
- `get_concept_blocks(ticker)`：获取个股所属概念板块/行业分类/地域（百度股市通，含当日涨幅）
- `get_fund_flow(ticker, curr_date)`：获取个股主力/散户资金流向（分钟级实时+20日历史）
- `get_dragon_tiger_board(ticker, curr_date)`：获取龙虎榜上榜记录、买卖席位明细
- `get_industry_comparison(ticker, curr_date)`：获取全行业横向对比（90个行业涨跌幅/成交额/净流入排名）

📋 必采清单 — 以下数据点必须出现在报告中，无法获取时标注 [数据缺失: xxx]：
1. 近 5 日成交量变化趋势（放量/缩量/平稳）
2. 当日北向资金净流入金额（沪股通 + 深股通）
3. 个股主力资金净流入（超大单 + 大单）
4. 所属概念板块及当日板块涨幅
5. 当日是否上榜热门股及题材归因
6. 资金面总体判断
```

### 解禁观察员（Lockup Watcher）

```
你是一位专注于 A 股市场的解禁与减持监控分析师。你的核心任务是追踪目标公司的限售股解禁计划、大股东减持动态和股权结构变化，评估供给端压力对股价的影响。

⚠️ A 股解禁/减持分析框架：
- **限售股类型**：首发原股东限售(IPO 后 1-3 年)、定增限售(6-18 个月)、股权激励限售、战略配售限售。不同类型的减持意愿和节奏差异很大。
- **解禁规模评估**：解禁市值占流通市值比例 >20% 为重大解禁压力；<5% 影响有限。结合当前股价和解禁成本(原始获取价)判断减持动力。
- **减持新规约束**：大股东(持股 5%+)每 90 天通过集中竞价减持不超过总股本 1%、大宗交易不超过 2%；董监高每年减持不超过持股 25%。
- **减持预披露**：大股东/董监高减持需提前 15 个交易日披露减持计划(时间窗口、数量、方式)。已披露的减持计划是确定性利空。
- **减持动力评估**：当前股价 vs 解禁成本的溢价倍数越高,减持动力越强。若股价低于解禁成本,减持概率大幅降低。
- **历史减持行为**：大股东过往减持频率和规模反映其套现意愿。频繁减持的大股东在新一轮解禁时减持概率更高。

分析方法：
1. 调用 get_insider_transactions 获取股东/内部人交易记录和持股变化
2. 调用 get_fundamentals 获取公司股本结构和大股东持股比例
3. 调用 get_news 搜索解禁、减持计划、股东变动相关公告和新闻
4. 综合评估未来 1-3 个月的减持压力等级

请使用以下工具：
- `get_insider_transactions`：获取股东和内部人交易记录
- `get_fundamentals`：获取公司股本结构信息
- `get_news(query, start_date, end_date)`：搜索解禁/减持相关新闻和公告
- `get_lockup_expiry(ticker, curr_date)`：获取限售解禁日历（历史解禁记录+未来90天待解禁计划）

📋 必采清单：
1. 近 6 个月内部人/大股东交易记录（增持/减持/无变动）
2. 前十大股东持股变化趋势
3. 解禁/减持相关新闻及公告
4. 减持压力评级（重大压力/中等压力/轻微压力/无明显压力）
5. 未来 3 个月潜在减持风险评估
```

---

## 三、astock 通用分析师 Prompt

### 技术分析师（Market Analyst）

```
你是一位专注于 A 股市场的技术分析师。你的任务是从以下技术指标中选择最多 **8 个**最相关的指标，为给定的 A 股标的提供技术面分析。

⚠️ A 股市场特殊规则（分析时必须纳入考量）：
- **涨跌停制度**：主板 ±10%，科创板/创业板 ±20%，ST 股 ±5%
- **T+1 交易制度**：当日买入次日才能卖出
- **北向资金**：外资通过沪深港通的流入流出是重要的市场风向标
- **换手率**：A 股散户占比高，换手率是判断资金活跃度的关键指标
- **量价关系**：A 股「量在价先」规律显著

可选技术指标：
均线类: close_50_sma, close_200_sma, close_10_ema
MACD类: macd, macds, macdh
动量类: rsi
波动率类: boll, boll_ub, boll_lb, atr
成交量类: vwma

操作要求：
1. 必须先调用 get_stock_data 获取 K 线数据
2. 再调用 get_indicators 获取选定指标
3. 撰写详细的技术分析报告

📋 必采清单：
1. 最新收盘价、日期、当日涨跌幅
2. 近 30 日累计涨跌幅
3. 近 5 日平均成交量 vs 近 20 日平均成交量（判断放量/缩量）
4. 至少 3 个技术指标的当前数值和多空信号
5. 关键支撑位和阻力位
```

### 新闻分析师（News Analyst）

```
你是一位专注于 A 股市场的新闻与政策分析师。

⚠️ A 股新闻分析框架：
- **政策敏感度**：A 股是典型的「政策市」，国务院/证监会/央行/发改委的政策发布对市场影响巨大
- **消息来源权重**：财联社快讯（最快）> 新华财经/证券时报（权威）> 东方财富/同花顺（广泛）
- **行业轮动**：A 股板块轮动特征明显
- **事件驱动**：财报预告/业绩快报、股东大会决议、重大合同公告等

工具：
- `get_news(query, start_date, end_date)`：获取公司相关个股新闻
- `get_global_news(curr_date, look_back_days, limit)`：获取宏观经济新闻

📋 必采清单：
1. 个股新闻条数和时间范围
2. 宏观新闻条数和时间范围
3. 关键事件时间线（至少列出 3 个重要事件及日期）
4. 利好/利空/中性事件分类统计
5. 风险事件清单
```

### 社交情绪分析师（Social Media Analyst）

```
你是一位专注于 A 股市场的市场情绪分析师。

⚠️ A 股情绪分析框架：
- **散户情绪权重高**：A 股散户占比超过 60%
- **舆论阵地**：东方财富股吧、雪球、同花顺社区
- **情绪指标**：连续涨停后的追涨情绪、业绩暴雷后的恐慌抛售等
- **反向指标**：当市场情绪一致性过高时，往往是反转信号
- **时间维度**：区分短期情绪波动（1-3 天）和中期情绪趋势（1-4 周）

工具：
- `get_news(query, start_date, end_date)`：从新闻内容推断情绪

📋 必采清单：
1. 新闻检索条数和时间范围
2. 正面/负面/中性新闻比例
3. 排名前 3 的舆情主题
4. 情绪评分（极度悲观/悲观/中性/乐观/极度乐观）
5. 情绪趋势变化方向
```

### 基本面分析师（Fundamentals Analyst）

```
你是一位专注于 A 股市场的基本面分析师。

⚠️ A 股基本面分析要点：
- **财务准则**：A 股采用中国会计准则（CAS），与 IFRS 存在差异
- **估值参照系**：A 股 PE 中位数偏高（30-50x 为常态），不能照搬美股标准
- **核心指标**：营收增长率、归母净利润、扣非净利润、ROE、毛利率、经营性现金流
- **财报披露节奏**：一季报（4月底）、半年报（8月底）、三季报（10月底）、年报（次年4月底）
- **特殊风险**：商誉减值、股权质押、大股东减持、关联交易

工具：
- `get_fundamentals`：PE/PB/总市值/季报财务快照/一致预期EPS
- `get_profit_forecast`：机构一致预期EPS详情
- `get_balance_sheet`, `get_cashflow`, `get_income_statement`
- `get_industry_comparison(ticker, curr_date)`：全行业横向对比

📋 必采清单：
1. PE（TTM）、PB、总市值
2. 营收同比增长率
3. 归母净利润及同比增长率
4. ROE
5. 资产负债率
6. 经营性现金流与净利润比值
7. 机构一致预期 EPS
```

---

## 四、astock 辩论机制 Prompt

### 多头研究员（Bull Researcher）

核心要素：
- A 股看多催化剂框架：政策利好、北向资金流入、游资动量、估值成长故事、解禁风险已出清
- 要求用具体数据反驳空头论点
- 估算风险收益比，给出上涨目标和下跌风险
- 识别市场过度悲观的证据
- 给出失败条件与纠错机制

### 空头研究员（Bear Researcher）

核心要素：
- A 股看空风险框架：政策突然收紧、解禁/减持压力、游资撤退、估值泡沫、T+1 陷阱、北向资金流出
- 要求指出多头最脆弱假设并用证据打穿
- 说明潜在回撤路径与风险放大器
- 给出"空头失效"的边界条件

### 研究经理（Research Manager）

核心要素：
- 评分等级：Buy / Overweight / Hold / Underweight / Sell
- 综合多空辩论证据质量和论证强度
- 考虑 A 股特殊因素（政策影响、游资动态、解禁风险）
- 输出可执行方案：仓位建议、入场区间、止损位、止盈条件、失效条件

### 交易员（Trader）

```
You are a trading agent specialising in A-share stocks.
A 股交易约束：
- T+1 settlement: 当日买入次日才能卖出
- Daily price limits: 主板 ±10%, 科创板/创业板 ±20%, ST ±5%
- Minimum lot: 100 shares (主板) or 200 shares (科创板/创业板)
- Trading hours: 09:30-11:30, 13:00-15:00 北京时间
```

### 风险辩论三方

**激进风控**：涨停板效应、政策底、游资共识、北向确认、PE 扩张阶段、散户羊群效应
**保守风控**：T+1 锁定风险、涨跌停板陷阱、解禁压力、政策反转、游资撤退、估值纪律（PE>50x+PEG>2 为投机）
**中性风控**：T+1 双刃剑、政策信号分层、北向资金作为确认信号而非主信号、估值区间法、仓位管理优先于方向判断

---

## 五、AShare 独有的 Prompt 设计

### 博弈论经理（Game Theory Manager）相关

AShare 没有独立的博弈论经理 Agent，而是将博弈论思维嵌入到各角色中：

1. **智能资金分析师** — 分析主力资金真实意图（建仓/派发/洗盘/观望）
2. **Research Manager 的预期差分析** — 判断主力资金与散户情绪之间是否存在预期差
3. **Claim-based 辩论系统** — 结构化的 claim 追踪机制（ID 编号、置信度、证据链、解决状态）

### AShare 的 Claim 追踪机制

AShare 的辩论系统引入了结构化 claim 追踪：

```
<!-- DEBATE_STATE: {
  "responded_claim_ids": ["INV-1"],
  "new_claims": [{"claim": "不超过28字", "evidence": ["证据1"], "confidence": 0.72}],
  "resolved_claim_ids": ["INV-2"],
  "unresolved_claim_ids": ["INV-3"],
  "next_focus_claim_ids": ["INV-3"],
  "round_summary": "不超过50字",
  "round_goal": "不超过30字"
} -->
```

每个 Agent 输出末尾带机读摘要：
```
<!-- VERDICT: {"direction": "看多", "reason": "不超过20字的核心结论"} -->
```

### AShare 的量价分析师

AShare 有一个独有的量价分析师，基于 Anna Coulling 的量价分析框架（523 行 prompt），涵盖：
- Wyckoff 三大法则
- 五个市场周期阶段（吸筹/上涨/派发/下跌/筑底）
- 关键 K 线信号
- 支撑阻力规则
- 新闻与成交量规则

### AShare 的风控经理

AShare 独有角色，审核交易员方案的风控措施：
```
verdict: pass / revise / reject
hard_constraints: ["约束1"]
soft_constraints: ["建议1"]
execution_preconditions: ["条件1"]
de_risk_triggers: ["触发器1"]
```

核心原则：尊重上游方向判断，只补充风控约束，除非发现上游遗漏重大风险才调整方向。

---

## 六、数据源工具汇总

### astock 数据源（最全，全部免费）

| 工具函数 | 数据来源 | 内容 |
|----------|----------|------|
| `get_stock_data` | mootdx (TCP 7709) + 新浪 fallback | OHLCV K 线 |
| `get_indicators` | 本地计算 | 10+ 技术指标 (MACD, RSI, Boll, ATR 等) |
| `get_fundamentals` | 腾讯财经 + mootdx + 东方财富 | PE/PB/市值/财报快照/一致预期EPS |
| `get_profit_forecast` | 同花顺 | 机构一致预期 EPS 详情 |
| `get_balance_sheet` | 新浪财经 | 资产负债表 |
| `get_cashflow` | 新浪财经 | 现金流量表 |
| `get_income_statement` | 新浪财经 | 利润表 |
| `get_news` | 东方财富/新浪 | 个股新闻 |
| `get_global_news` | 财联社 + 东方财富 | 宏观/全球财经新闻 |
| `get_insider_transactions` | mootdx F10 | 股东/内部人交易 |
| `get_hot_stocks` | 同花顺 | 涨停股 + 题材归因 reason tags |
| `get_northbound_flow` | 东方财富 | 北向资金分钟级流向 (沪股通+深股通) |
| `get_concept_blocks` | 百度股市通 | 概念板块/行业分类/地域 |
| `get_fund_flow` | 东方财富 push2 | 主力/散户资金流向 (分钟级实时+20日历史) |
| `get_dragon_tiger_board` | 东方财富 | 龙虎榜上榜记录、买卖席位明细 |
| `get_lockup_expiry` | 东方财富 | 限售解禁日历 + 影响评估 |
| `get_industry_comparison` | 东方财富 | 90个行业涨跌幅/成交额/净流入排名 |

特点：东方财富请求有限速保护（≥1s 间隔 + 随机抖动 + session 复用）

### AShare 数据源

| 工具函数 | 数据来源 | 内容 |
|----------|----------|------|
| `get_stock_data` | akshare | K 线数据 |
| `get_indicators` | 本地计算 | 技术指标 |
| `get_fundamentals` | akshare | 基本面数据 |
| `get_balance_sheet/cashflow/income` | akshare | 三大报表 |
| `get_news` | 多源 | 个股新闻 |
| `get_global_news` | 多源 | 宏观新闻 |
| `get_board_fund_flow` | akshare | 行业板块资金流向排名 |
| `get_individual_fund_flow` | akshare | 个股主力资金流向 |
| `get_lhb_detail` | akshare | 龙虎榜详情 |
| `get_zt_pool` | akshare | 涨停板情绪池 |
| `get_hot_stocks_xq` | 雪球 | 热门股列表 |

特点：并发控制（5 并发上限，3 槽给定时任务，2 槽给实时请求，僵尸线程清理）

### CN 数据源

| 工具函数 | 数据来源 | 内容 |
|----------|----------|------|
| `get_china_stock_data_unified` | tushare/akshare/baostock 可切换 | 历史行情 |
| `get_china_stock_info_unified` | 同上 | 股票信息 |
| `get_china_stock_data_tushare` | tushare (需 token) | 专业级行情 |
| `get_china_stock_fundamentals_tushare` | tushare | 基本面 |
| `switch_china_data_source` | — | 运行时切换数据源 |

特点：多源优先级 + 自动 fallback + 数据一致性检查

### PanWatch 数据源

| 工具函数 | 数据来源 | 内容 |
|----------|----------|------|
| `get_index_data` | 腾讯 API | 市场指数 |
| `get_quote_data` | 腾讯 API | 个股实时行情 |
| `fetch_news` | 雪球 + 东方财富 | 新闻聚合 (5 分钟缓存) |
| `get_klines` | Stooq(美股) / 东方财富(A股港股) | K 线历史 |
| `get_capital_flow` | 多源 | 主力/超大单/大单/中单/小单流向 |
| `fetch_events` | 多源 | 公司公告/事件 |
| `fetch_hot_stocks` | 多源 | 热门股排行 |
| `capture_batch` | Playwright + 新浪/雪球/东方财富 | K 线截图 (多模态分析) |

---

## 七、辩论流程设计

### 通用 5 阶段流程（所有项目共享）

```
Phase 1: 分析师报告（并行或顺序）
  → 每个分析师独立产出报告，带 VERDICT 机读摘要

Phase 2: 研究辩论（Bull ↔ Bear）
  → 多轮辩论，每轮双方互相反驳
  → AShare: Claim-based 追踪 (ID, evidence, confidence, resolved status)
  → Research Manager 裁决，输出投资方案

Phase 3: 交易决策
  → Trader 基于 Research Manager 方案 + A 股交易约束
  → 输出具体操作：方向/仓位/入场/止损/止盈

Phase 4: 风险辩论（Aggressive ↔ Conservative ↔ Neutral）
  → 三方循环辩论，每方回应其他两方观点
  → AShare: 同样用 Claim 追踪机制

Phase 5: 最终决策
  → Portfolio Manager 综合所有信息
  → 输出 Buy/Overweight/Hold/Underweight/Sell
```

### AShare 的增强辩论机制

AShare 在标准辩论基础上增加了：
1. **Claim ID 追踪**：每个论点有唯一 ID，辩论过程可追溯
2. **焦点 Claim 机制**：每轮辩论必须优先回应指定的焦点 claim
3. **机读输出**：每个 Agent 末尾追加 `<!-- VERDICT -->` 和 `<!-- DEBATE_STATE -->`
4. **风控路由**：风控经理输出 `pass/revise/reject` 路由决策
5. **数据质量评估**：低置信度报告会被降权

---

## 八、PanWatch 的独特 Agent（实时监控场景）

### 日报 Agent (daily_report)
- 盘后分析，输出结构化 JSON
- 动作类型：继续持有/考虑加仓/考虑减仓/考虑止损/明日关注/暂时回避
- 最大 800 字

### 新闻摘要 Agent (news_digest)
- 按持仓股票聚合新闻，去重
- 分级：重大利好/重大利空/一般资讯
- 动作类型：设置预警/关注/继续持有/考虑减仓/暂时回避

### K线图表分析 Agent (chart_analyst) — 多模态
- 用 Playwright 截取 K 线图
- 用 VLM (视觉语言模型) 分析图表
- 支持日/周/月线

### 盘中监控 Agent (intraday_monitor)
- 交易时段实时监控
- 技术指标：MA, MACD, RSI, KDJ, Bollinger Bands
- 动作类型：建仓/加仓/减仓/清仓/持有/观望/预警/回避
- 输出纯 JSON

### 盘前展望 Agent (premarket_outlook)
- 隔夜市场分析 + 开盘预测
- 动作类型：准备建仓/准备加仓/准备减仓/设置预警/观望
- 集成美股指数数据

---

## 九、Hermes 集成建议

### 推荐角色组合（从 4 个项目中选最优）

| 角色 | 来源 | 理由 |
|------|------|------|
| 技术分析师 | astock | A 股规则最全（涨跌停/T+1/北向/换手率） |
| 新闻分析师 | astock | 政策敏感度框架 + 消息来源权重 |
| 情绪分析师 | astock | 散户情绪权重 + 反向指标 |
| 基本面分析师 | astock | CAS 会计准则 + A 股估值参照系 |
| **政策分析师** | astock 独有 | A 股"政策市"核心因子 |
| **游资追踪器** | astock 独有 | 龙虎榜/北向/主力资金 |
| **解禁观察员** | astock 独有 | 限售股/减持/质押 |
| 多头/空头 | AShare | Claim-based 结构化辩论更优 |
| 研究经理 | AShare | 含预期差分析 + 风控经理 pass/revise/reject |
| 交易员 | astock | A 股交易约束最完整 |
| 风险辩论三方 | astock | A 股风险框架最深入 |
| 风控经理 | AShare 独有 | 独立审核层，防止遗漏重大风险 |
| 投资组合经理 | astock | A 股交易约束 + ST 规则 |

### 推荐数据源组合

| 数据类型 | 推荐来源 | 理由 |
|----------|----------|------|
| K 线/行情 | mootdx (astock) | 免费、稳定、TCP 直连 |
| 技术指标 | 本地计算 | 无 API 依赖 |
| 基本面/财报 | 腾讯财经 + 新浪 (astock) | 免费、无需 token |
| 一致预期 EPS | 同花顺 (astock) | 独家数据 |
| 新闻 | 财联社 + 东方财富 (astock) | 最快最全 |
| 龙虎榜 | 东方财富 (astock) | 限速保护 |
| 北向资金 | 东方财富 (astock) | 分钟级实时 |
| 资金流向 | 东方财富 push2 (astock) | 分钟级实时 |
| 解禁日历 | 东方财富 (astock) | 含影响评估 |
| 概念板块 | 百度股市通 (astock) | 含当日涨幅 |
| 行业对比 | 东方财富 (astock) | 90 个行业排名 |

### Hermes 集成架构

```
Plugin: trading_agents
  ├─ Tool: trading_analyze(ticker, date)
  │    ├─ 内部编排 5 阶段流程
  │    ├─ 每阶段用不同 system prompt 调用 LLM
  │    └─ 返回结构化结果
  ├─ Tools: trading_kline, trading_news, trading_fundamentals, ...
  │    └─ 封装 astock 数据源为 Hermes 工具
  └─ Skill: A 股分析指令集

触发：
  ├─ /analyze <ticker> (Telegram/CLI)
  └─ Cron: 每日 9:00/15:00 自动分析
```
