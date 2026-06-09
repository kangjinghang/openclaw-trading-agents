# 竞品对比调研：提示词与数据源

> 调研日期：2026-06-08
> 对比对象：本地 `~/workspace/github` 下的 PanWatch、TradingAgents-AShare、TradingAgents-CN、TradingAgents-astock 四个项目
> 范围：仅聚焦**提示词（Prompt）**与**数据源（Data Source）**两个维度，找出本插件可借鉴之处

---

## 1. 五个项目定位

| 项目 | 定位 | 提示词形态 | 数据源形态 | 与我们的关系 |
|------|------|-----------|-----------|------------|
| **openclaw-trading-agents**（本项目） | OpenClaw 插件，TS 编排 | 14 个独立 `.md` 模板 + `<!-- VERDICT -->` 协议 | 8 个 skill 脚本 + 文件缓存 | — |
| **PanWatch** | 单股盯盘 / 盘前盘后（非多 Agent 辩论） | 5 个 `.txt`，面向"操作建议" | Tencent 主，覆盖 CN/HK/US | 操作建议表达可借鉴 |
| **TradingAgents-AShare** | 多 Agent 辩论，**提示词工程最深** | `zh.py`/`en.py` 集中常量 | akshare + baostock，并发锁做得很重 | 提示词主要借鉴对象 |
| **TradingAgents-CN** | 生产级全栈（LangGraph） | 提示词内嵌 Python + 工具调用 + 记忆 | 统一接口 + MongoDB 缓存 + tushare | 工程化思路（部分） |
| **TradingAgents-astock** | **和本项目最像**（7 分析师 + 必采清单） | 提示词内嵌，含质量门 A-F | 17 个数据方法，**最全** | 数据源主要借鉴对象 |

**核心结论**：本项目与 astock 架构最接近（7 分析师 + 必采清单 + mootdx/akshare/eastmoney 同源数据栈），但 **ASHare 的提示词工程明显领先**，**astock 的数据覆盖最全**。CN 偏工程化（缓存/记忆），PanWatch 偏操作建议表达。

---

## 2. 提示词（Prompt）可借鉴

### ⭐⭐⭐ 高价值

#### 2.1 结构化多轮辩论状态追踪 —— 已完成 ✅ —— TradingAgents-AShare【最大收获】

**现状**：本项目的 Bull/Bear 每轮各自输出 `BULL-N`/`BEAR-N` claims（见 `skills/trading-analysis/prompts/debate/bull_researcher.md`），但**轮与轮之间是平行独白**，不强制回应对方，辩论容易各说各话。

**借鉴点**：ASHare 用一个 `DEBATE_STATE` 结构强制收敛，每轮必须先回应对方最强 claim，再提新 claim：

```python
# 出处：TradingAgents-AShare/tradingagents/prompts/zh.py
<!-- DEBATE_STATE: {
    "responded_claim_ids": ["INV-1"],          # 本轮回应了对方哪几条
    "new_claims": [{"claim": "...", "evidence": [...], "confidence": 0.72}],
    "resolved_claim_ids": ["INV-2"],           # 已被反驳击穿的
    "unresolved_claim_ids": ["INV-3"],
    "next_focus_claim_ids": ["INV-3"],         # 下轮聚焦哪条
    "round_summary": "...", "round_goal": "..."
} -->
```

**收益**：辩论从"平行独白"变成"打靶"，多空真正对抗、可收敛。
**改动范围**：`bull_researcher.md` / `bear_researcher.md` + `src/debate.ts` 解析逻辑。

---

#### 2.2 风控输出"结构化约束"而非 pass/revise/reject —— 已完成 ✅ —— TradingAgents-AShare

**现状**：本项目风控经理只给 `pass/revise/reject`（见 `skills/trading-analysis/prompts/debate/risk_manager.md`），下游很难直接用。

**借鉴点**：ASHare 直接产出可执行约束：

```python
# 出处：TradingAgents-AShare/tradingagents/prompts/zh.py (risk_manager_prompt)
<!-- RISK_JUDGE: {
    "verdict": "pass",
    "hard_constraints": ["仓位≤30%"],          # 硬约束
    "soft_constraints": ["分两笔建仓"],         # 软建议
    "execution_preconditions": ["开盘不追高"],  # 进场前提
    "de_risk_triggers": ["跌破 60.5 减半仓"]    # 降风险触发器
} -->
```

**收益**：交易员和用户能直接拿到止损/仓位/触发条件，风控输出从"二值门"升级为"可执行清单"。
**改动范围**：`risk_manager.md` + `src/risk.ts`。

---

#### 2.3 把完整量价理论框架喂给 LLM —— TradingAgents-AShare

**现状**：本项目 `skills/trading-kline/scripts/kline.py` 已**预计算 VPA**，但 `market.md` 只给了"指标解读参考表"，没给 LLM 这套 VPA 的理论体系。

**借鉴点**：ASHare 把 Anna Coulling 量价分析 + **威科夫三大定律**（供求 / 因果 / 投入产出）+ **市场循环五阶段**（吸筹 → 上升 → 派发 → 下降）整段塞进 prompt。

```
出处：TradingAgents-AShare/tradingagents/prompts/zh.py (volume_price_system_message)
威科夫三大定律：
| 供求定律   | 价格由买卖力量对比决定       | 用成交量判断谁占主导   |
| 因果定律   | 积累时间越久，突破幅度越大   | 整理越久趋势越持久     |
| 投入产出   | 大价格变动需大成交量         | 量价不匹配 = 异常信号   |
```

**收益**：同样的预计算 VPA 数据，套上理论框架后 LLM 能解读出更多东西。**纯 prompt 改动，零运行时成本**。
**改动范围**：仅 `market.md`（可选：新增独立 `volume_price.md` 分析师，对标 ASHare）。

---

### ⭐⭐ 中价值

#### 2.4 操作建议带"触发器 / 失效条件" —— 已完成 ✅ —— PanWatch

**借鉴点**：每条建议附"等什么信号才动手"和"出现什么就推翻判断"：

```
# 出处：PanWatch/prompts/daily_report.txt
{ "action": "reduce", "signal": "放量滞涨",
  "triggers": ["若冲高不放量"],          # 等什么进场
  "invalidations": ["重新放量突破压力"] }  # 什么情况判断作废
```

**收益**：本项目 `trader.md` 现给目标价/止损，补充"进场触发/失效条件"后更贴实战。
**改动范围**：`trader.md`。

---

#### 2.5 自我反思 / 复盘闭环 —— TradingAgents-AShare

**借鉴点**：专门的 `reflection_system_prompt`，对每次决策判成败、跨维度归因、给改进建议。
**收益**：可作为事后（或下次同票时）回看机制，形成学习闭环。
**前置条件**：需先有"结果记录"才有意义 → 属路线图项，非即时可做。

> 📌 **实现级深度设计已落档**（延期，待规划）：两种形态（in-run 一致性校验 / cross-run 复盘）、与 P3 记忆的耦合关系、TA 反思为死代码的核实、代码草图与实施顺序 → 见 [design/deferred-memory-and-reflection.zh.md](design/deferred-memory-and-reflection.zh.md)。

---

#### 2.6 辩论层用英文推理、面向用户用中文 —— TradingAgents-astock

**借鉴点**：astock 的经验是英文推理链质量更高（user-facing Chinese / internal-debate English）。
**收益**：本项目全程中文，值得做一组 A/B 实验验证（**不一定改默认**）。
**出处**：`TradingAgents-astock/CHANGES_FROM_UPSTREAM.md`。

---

## 3. 数据源可借鉴

### ⭐⭐⭐ 高价值（填补本项目明显空白）

#### 3.1 龙虎榜数据字段补齐 —— 已完成 ✅（commit `fa389a0`）

**调研纠错**：初稿误判本项目"缺龙虎榜"。实际情况——`hot_money.py` 的 `_fetch_dragon_tiger` 早已通过 Eastmoney datacenter `RPT_DAILYBILLBOARD_DETAILSNEW` 拉取龙虎榜，但**只提取 4 个字段**（date / reason / net_buy / turnover）。

**借鉴点（已修正理解）**：ASHare 的 `get_lhb_detail` 调 `ak.stock_lhb_detail_em`，返回全 DataFrame（约 15 列），**同样是汇总级——并非席位明细**。akshare 的席位级接口是 `stock_lhb_stock_detail_em`，但 ASHare 也未使用。

```python
# 出处：TradingAgents-AShare/tradingagents/dataflows/providers/cn_akshare_provider.py:900
def get_lhb_detail(self, symbol: str, date: str) -> str:
    df = ak.stock_lhb_detail_em(symbol=code, start_date=date, end_date=date)
    return f"{symbol} 龙虎榜明细（{date}）：\n{df.head(20).to_string(index=False)}"
```

**已做改动**：
- `_fetch_dragon_tiger` 字段 4 → 8 个/条（新增 buy_amt / sell_amt / close_price / change_rate），与 ASHare 持平
- `hot_money.md` prompt #4 同步更新，去掉汇总级数据无法支撑的"买卖席位分析"

**真实剩余差距**（席位明细，优先级 P3）：营业部买卖席位 + 机构参与需要 Eastmoney `RPT_BILLBOARD_TRADEDETAILS` 或 akshare `stock_lhb_stock_detail_em`，ASHare / astock 均未实现，属共同空白。

---

#### 3.2 一致预期 / 远期 PE-PEG（机构盈利预测） —— 已完成 ✅ —— astock

**调研纠错**：初稿称本项目 fundamentals.py "仅向后看"。实际情况——`_fetch_consensus_eps` 早已对接 Eastmoney `RPT_WEB_RESPREDICT`，但**实现有 3 个 bug 导致从未跑通**：
1. `sortColumns=REPORTDATE` —— 该报表无此列，请求每次以 `success=False` 失败；
2. 字段名全错（取 `PREDICT_EPS_THISYEAR` / `TARGET_PRICE` / `RESEARCHER_NUM`，实际是 `EPS1-4` / `DEC_AIMPRICEMAX` / `RATING_ORG_NUM` 等）；
3. `"result": null` 时 `d.get("result", {}).get(...)` 崩溃（默认值仅在键缺失时生效，键值为 null 时不生效）。

**借鉴点**：astock 拉了一致预期 EPS、forward PE、PEG、PE 消化时间。

```
出处：TradingAgents-astock（get_profit_forecast，来源同花顺）
- 共识 EPS、forward PE、PEG、PE 消化时间
```

**收益**：A 股成长股定价基本看一致预期，这是基本面分析**最大的盲点**。
**注意**：同花顺爬取较脆，本项目沿用 Eastmoney datacenter（已在用，免 token）。

**已做改动**：
- 修复 3 个 bug：移除 `sortColumns`、按真实字段映射、`(j.get("result") or {})` 防御 null。
- 重构返回为结构化：`forecast_years`（4 年 EPS，A=实际/E=预测）、`consensus_eps_current/next`、`analyst_count`、`ratings`（买入/增持/中性/减持/卖出分布）、`target_price_min/max`。
- Python 侧预计算远期估值（遵循本项目"预计算避免 LLM 算错"惯例）：`eps_growth_pct`、`forward_pe = 现价 / 次年 EPS`、`peg = PE_TTM / 预期增速`（仅正增长时）。
- `fundamentals.md` 字段说明 + 必采清单 §4 同步更新，显式要求 LLM 解读 forward_pe 与 PEG。
- 实测：茅台 PEG 4.04（低增速偏贵）/ 宁德时代 PEG 0.70（高增速下被低估），区分度有效。

---

#### 3.3 涨停板情绪池 / 连板梯队 —— ASHare —— 已完成 ✅

**现状**：本项目 `skills/trading-sentiment/scripts/sentiment.py` 拿的是市场宽度（eastmoney push2 clist）。

**借鉴点**：`zt_pool`（涨停家数 + 连板分布）是 A 股独有的短线情绪温度计，比市场宽度更能反映打板情绪。

```python
# 出处：TradingAgents-AShare/tradingagents/dataflows/cn_akshare_provider.py
def get_zt_pool(self, date: str) -> str:
    # 涨停家数、连板分布 → 情绪温度计
```

**收益**：补一个 A 股特色、短线交易者真正看的情绪代理。

**已做改动**：
- `sentiment.py` 新增 `_fetch_zt_pool(date, code)`，调 akshare `stock_zt_pool_em`（底层 Eastmoney push2ex），返回 `limit_up_count`（涨停家数）、`max_streak`（最高连板 = 龙头）、`streak_distribution` + `streak_distribution_text`（连板梯队，预格式化如 "6板1家/2板11家/1板43家"）、`top_industries`（涨停行业 top5）、`target_in_pool`（标的命中检测，含连板数 / 行业）、`previous_day_count`（昨日对比，判断情绪升降）、`actual_date`。
- 非交易日回溯最多 4 天找最近交易日；akshare lazy import + try/except graceful degrade（与 `fundamentals.py` mootdx 模式一致）。
- `sentiment.md` 字段说明 + 必采清单新增 §4"涨停情绪池（短线温度计）"，引导 LLM 解读连板梯队高度 / 打板强度 / 行业集中度 / 标的命中；原 §4 综合评估 → §5。
- 实测（2026-06-09）：涨停 57 家，龙头 6 板，2 板以上 13 家；603500 命中 `target_in_pool`（3 板），600519 未命中。

---

### ⭐⭐ 中价值

#### 3.4 北向资金升为一等信号 —— 三家都强调

**现状**：本项目北向数据**埋在 `hot_money.py`**（hexin HSGT dayChart + eastmoney fflow），未独立突出。

**借鉴点**：三家都把它当独立、突出信号。astock 甚至做了**分钟级实时 + 本地 CSV 缓存**（因上游 API 不稳）。

```python
# 出处：TradingAgents-astock（get_northbound_flow）
# 实时分钟级 HGT+SGT 累计流 + 本地 CSV 历史缓存（绕开上游 API 故障）
```

**收益**：至少在 hot_money 分析师 prompt 把北向单列为必采项；或拆成独立数据点。
**改动范围**：prompt 改动优先（零数据改动），数据独立化次之。

---

#### 3.5 三大报表完整拉取 —— astock

**现状**：`fundamentals.py` 拿 PE/PB/EPS 快照（Tencent + mootdx + Eastmoney）。

**借鉴点**：astock 用新浪分别拉**资产负债表 / 现金流量表 / 利润表**三张完整报表，能做真实的盈利质量分析（如经营性现金流 vs 净利润）。

```
出处：TradingAgents-astock（get_balance_sheet / get_cashflow / get_income_statement，来源 Sina Finance）
```

**改动范围**：`fundamentals.py` 增加报表段。

---

#### 3.6 板块资金流排名 —— ASHare —— 已完成 ✅

**现状**：本项目 `skills/trading-sector/scripts/sector.py` 有板块列表 + 相关概念块，但缺**板块主力资金净流入排名**。调研发现 **`sector.py` 是孤儿脚本**——`orchestrator.ts` 的 7 个分析师配置（market / fundamentals / news / sentiment / policy / hot_money / lockup）均不调用它，数据无消费者。

**借鉴点**：

```python
# 出处：TradingAgents-AShare (get_board_fund_flow)
# 行业板块资金流向排名：排名 / 板块名称 / 今日主力净流入净额
```

**收益**：板块轮动是 A 股主驱动之一。

**已做改动**（注入 hot_money 而非孤儿 sector.py —— 用户已确认）：
- `hot_money.py` 新增 `_fetch_sector_fund_flow()`，调东财 push2 clist（`fs=m:90+t:2` 行业板块 ~90 个，`fields=f62/f184/f136`），Python 侧按主力净流入排序，返回 `inflow_top`（top8 净流入 = 主线）/ `outflow_top`（top8 净流出 = 弱势）/ `total_boards`；每项含 `main_net_yi` / `super_net_yi` / `main_net_pct` / `change_pct`。
- hot_money 本是主力资金追踪者（北向 / 个股资金流 / 龙虎榜），板块资金流是个股资金流的市场级递进，语义契合，复用已有分析师渠道即时生效。
- `hot_money.md` 字段说明 + 必采清单新增 §4"板块资金流排名（板块轮动信号）"，引导 LLM 解读主线 vs 弱势 + 标的行业归属；原 §4-§6 顺延为 §5-§7。
- 注意：push2 字段基于东财官方文档（f62 主力净流入等，akshare 同源）；实施期遇 push2 临时限流，已验证 graceful degrade（返回 None 不影响其他字段）。

---

### 工程稳健性（出问题时可参考）

#### 3.7 akshare 并发安全 —— ASHare
akshare 以线程泄漏/卡死闻名。ASHare 给它做了**并发锁 + zombie 线程回收**。本项目刚修完 stdin EOF 卡死问题（见 `memory/exec-python-stdin-eof-blocks.md`），若以后并发拉 akshare 再卡，直接抄这个模式。
**出处**：`TradingAgents-AShare/tradingagents/dataflows/cn_akshare_provider.py`。

#### 3.8 Eastmoney 限流 —— astock
Eastmoney 对激进调用会封 IP。astock 用 `1.0s + 0.1~0.5s 抖动` + Keep-Alive + 模块级时间戳。值得确认本项目 `src/http_helpers`（Python 侧）是否有限流，没有就加。

#### 3.9 ❌ 不建议抄：MongoDB TTL 缓存 —— TradingAgents-CN
他们是生产级多用户服务才需要。本项目的**文件 JSON + TTL 缓存对插件场景正好合适**，不要上 MongoDB。

---

## 4. 本项目已做得好的（勿重复造）

- **提示词独立 `.md` + VERDICT 协议**：4 家里只有本项目用纯模板文件，可读性/可维护性最好（其他都内嵌 Python 常量）
- **预计算技术指标 + VPA 注入 prompt**：与 ASHare 持平，避免 LLM 自己算错
- **必采清单 + 数据质量门 A-F**：方向与 astock 一致；astock 是**双层门**（硬检查 + LLM 复核），可考虑加深
- **文件缓存层**（`src/exec-python.ts`）：对插件规模正合适

---

## 5. 行动建议（按性价比排序）

| 优先级 | 改动 | 类型 | 工作量 | 出处 |
|--------|------|------|--------|------|
| ~~P0~~ ✅ | 龙虎榜字段补齐 `hot_money.py`（4→8 字段，已与 ASHare 持平） | 数据 | 小 | §3.1 |
| ~~P0~~ ✅ | 威科夫/量价理论框架塞入 `market.md` | 提示词 | 小（纯文本） | §2.3 |
| ~~P1~~ ✅ | 风控结构化约束（hard/soft/precondition/trigger） | 提示词+解析 | 中 | §2.2 |
| ~~P1~~ ✅ | DEBATE_STATE 辩论状态追踪 | 提示词+解析 | 中（辩论收敛质变） | §2.1 |
| ~~P2~~ ✅ | trader 加 triggers/invalidations | 提示词 | 小 | §2.4 |
| ~~P2~~ ✅ | 一致预期 EPS/PEG 数据 | 数据 | 中（接口选型） | §3.2 |
| ~~P3~~ ✅ | 涨停情绪池（连板梯队） | 数据 | 中 | §3.3 |
| ~~P3~~ ✅ | 板块资金流排名 | 数据 | 中 | §3.6 |
| **P3** | 双层数据质量门 | 工程 | 中 | §4 |
| 路线图 | 自我反思闭环 | 提示词+存储 | 大 | §2.5 |
| 实验 | 辩论层英文推理 A/B | 提示词 | 小 | §2.6 |

**P0 + P1 + P2 + P3(§3.3/§3.6) 均已完成**。P0 见 commit `fa389a0`；P1 含 §2.1 DEBATE_STATE + §2.2 RISK_JUDGE；P2 含 §2.4 trader triggers/invalidations 与 §3.2 一致预期 EPS/PEG；P3 已完成 §3.3 涨停情绪池（`sentiment.py` `zt_pool`）与 §3.6 板块资金流（注入 `hot_money.py`——调研发现 `sector.py` 是孤儿脚本）。另修 `_fetch_quarterly_financials`（§3.2 sibling）。**剩余 P3（双层质量门 §4）及实验/路线图层**（自我反思闭环、辩论英文推理 A/B）。

---

## 附录 A：各项目关键文件路径（溯源）

| 项目 | 提示词 | 数据源 |
|------|--------|--------|
| PanWatch | `prompts/{daily_report,intraday_monitor,premarket_outlook,chart_analyst,news_digest}.txt` | `src/` 下 collector 模块（Tencent / Eastmoney / Xueqiu） |
| TradingAgents-AShare | `tradingagents/prompts/{zh,en}.py`、`catalog.py` | `tradingagents/dataflows/cn_akshare_provider.py`、`cn_baostock_provider.py` |
| TradingAgents-CN | `tradingagents/agents/{analysts,researchers,risk_mgmt,managers,trader}/*.py`（内嵌） | `tradingagents/dataflows/interface.py`、`dataflows/data_cache/` |
| TradingAgents-astock | `tradingagents/agents/**/*.py`（内嵌）、`CHANGES_FROM_UPSTREAM.md` | `tradingagents/` 下 17 个 data 方法 |
| openclaw-trading-agents（本） | `skills/trading-analysis/prompts/{analysts,debate}/*.md` | `skills/trading-*/scripts/*.py` |

## 附录 B：本项目当前提示词清单

```
skills/trading-analysis/prompts/
├── analysts/        7 个分析师：market / fundamentals / news / sentiment / policy / hot_money / lockup
├── portfolio_manager.md
└── debate/          bull / bear / research_manager / trader / risk_debater / risk_manager
共 14 个模板，1361 行
```

## 附录 C：本项目当前数据脚本

| 脚本 | 主数据源 | 覆盖 |
|------|---------|------|
| `trading-kline/scripts/kline.py` | mootdx（主）+ akshare（备） | K 线 OHLCV、技术指标、VPA |
| `trading-fundamentals/scripts/fundamentals.py` | Tencent + mootdx + Eastmoney | PE/PB/EPS 估值快照 |
| `trading-news/scripts/news.py` | Eastmoney + 财联社(cls.cn) | 个股新闻 |
| `trading-sentiment/scripts/sentiment.py` | Eastmoney push2 | 市场宽度情绪 |
| `trading-policy/scripts/policy.py` | Eastmoney + 财联社 | 政策/宏观新闻 |
| `trading-hot-money/scripts/hot_money.py` | Hexin HSGT + Eastmoney fflow + 同花顺(10jqka) | 北向、主力资金、涨停（**缺龙虎榜**） |
| `trading-lockup/scripts/lockup.py` | Eastmoney datacenter + mootdx F10 | 解禁、内部交易 |
| `trading-sector/scripts/sector.py` | Eastmoney + Baidu PAE | 板块、概念块（**缺资金流排名**） |
