# Phase 2 设计：补全 7 个分析师

## 目标

将 Phase 1 的单分析师（market）扩展为 7 个分析师并行分析，每个分析师有独立的数据 Skill 和 Prompt 模板。最终流程：7 个数据脚本并行 → 7 个分析师并行 LLM 调用 → Portfolio Manager 综合决策。

## 新增数据 Skill（6 个）

现有 `trading-kline` 提供 K 线数据，新增 6 个独立 Skill 目录，每个结构与 `trading-kline` 一致（`SKILL.md` + `scripts/`）。

### trading-fundamentals

- **脚本**: `fundamentals.py`
- **数据源**: 腾讯财经 (PE/PB/市值) + 新浪财经 (三大报表) + 同花顺 (EPS 预测)
- **输出**: JSON 包含 PE/PB/总市值、营收/净利润增长率、ROE、资产负债率、经营性现金流、机构一致预期 EPS
- **参数**: `--ticker`, `--date`
- **服务**: 基本面分析师

### trading-news

- **脚本**: `news.py`
- **数据源**: 东方财富 (个股新闻) + 财联社 (宏观/全球财经新闻)
- **输出**: JSON 包含个股新闻列表、宏观新闻列表，每条新闻含标题/来源/日期/摘要
- **参数**: `--ticker`, `--date`, `--lookback-days 7`
- **服务**: 新闻分析师、政策分析师（复用宏观新闻）

### trading-hot-money

- **脚本**: `hot_money.py`
- **数据源**: 东方财富 (北向资金/个股资金流向/龙虎榜) + 同花顺 (涨停股+题材归因)
- **输出**: JSON 包含北向资金净流入、主力资金净流入、龙虎榜记录、涨停股列表
- **参数**: `--ticker`, `--date`
- **限速**: 东方财富请求 ≥1s 间隔 + 随机抖动 + session 复用
- **服务**: 游资追踪器

### trading-sentiment

- **脚本**: `sentiment.py`
- **数据源**: 东方财富 (热门股排行) + 东方财富 (个股新闻，脚本内部独立请求)
- **输出**: JSON 包含热门股排行、涨停股数量、市场情绪指标
- **参数**: `--ticker`, `--date`
- **服务**: 情绪分析师

### trading-lockup

- **脚本**: `lockup.py`
- **数据源**: 东方财富 (限售解禁日历) + mootdx F10 (股东/内部人交易)
- **输出**: JSON 包含解禁计划、内部人交易记录、减持压力评级
- **参数**: `--ticker`, `--date`
- **服务**: 解禁观察员

### trading-sector

- **脚本**: `sector.py`
- **数据源**: 东方财富 (90 个行业涨跌幅/成交额/净流入排名) + 百度股市通 (概念板块/行业分类/地域)
- **输出**: JSON 包含行业排名、所属概念板块及涨幅、行业资金流向
- **参数**: `--ticker`, `--date`
- **服务**: 多个分析师共享（游资/政策/基本面）

## 数据源实现策略

- **Primary**: mootdx TCP 7709（K 线、F10 财务数据）
- **Fallback**: 直接 HTTP API（腾讯财经、东方财富、新浪财经、百度股市通）
- **不依赖** akshare，避免反爬问题
- 东方财富请求限速：≥1s 间隔 + random 0.1-0.5s 抖动 + requests.Session 复用
- 每个 Python 脚本独立，接收 `--ticker` `--date` 参数，输出 JSON 到 stdout

## 新增分析师 Prompt（6 个）

已有 `analysts/market.md`，新增 6 个模板在 `skills/trading-analysis/prompts/analysts/` 下：

| 文件 | 分析师 | 必采清单要点 |
|------|--------|-------------|
| `fundamentals.md` | 基本面分析师 | PE/PB/市值、营收增长率、归母净利润、ROE、资产负债率、现金流、机构 EPS 预期 |
| `news.md` | 新闻分析师 | 个股新闻条数、宏观新闻条数、关键事件时间线、利好/利空分类、风险事件 |
| `sentiment.md` | 情绪分析师 | 正面/负面/中性比例、前 3 舆情主题、情绪评分、情绪趋势 |
| `policy.md` | 政策分析师 | 政策事件清单、行业方向判断、力度评级、时间窗口、总体评级 |
| `hot_money.md` | 游资追踪器 | 成交量趋势、北向资金、主力净流入、概念板块涨幅、龙虎榜、资金面判断 |
| `lockup.md` | 解禁观察员 | 内部人交易、股东变化、解禁新闻、减持压力评级、未来 3 月风险 |

所有 Prompt 基于 `trading-agents-reference.md` 中 astock 的 Prompt 设计，包含：
- A 股特殊规则（涨跌停/T+1/北向资金）
- 角色专属分析框架
- 必采清单（数据缺失时标注 `[数据缺失: xxx]`）
- `<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "..."} -->` 机读结论

## Orchestrator 改造

### 当前流程（Phase 1）

```
K线数据 → market analyst → portfolio manager
```

### Phase 2 流程

```
7个数据脚本并行获取 → 7个分析师并行 LLM → portfolio manager
```

### 具体改动

`orchestrator.ts` 中的 `runQuickAnalysis()` 改造：

1. **数据获取阶段**: `Promise.all()` 并行调用 7 个 Python 脚本
   - 每个脚本失败不阻塞其他（graceful degradation，标记 `[数据缺失]`）

2. **分析师阶段**: `Promise.all()` 并行调用 7 个 LLM
   - 每个分析师用各自的 system prompt + 对应数据
   - 每个调用独立 trace logging
   - 单个分析师失败不阻塞（返回错误报告）

3. **PM 阶段**: 拼接 7 份报告交给 `portfolio_manager.md`
   - `analyst_reports` 模板变量包含所有 7 份报告
   - `FinalDecision.analyst_verdicts` 填入所有 7 个分析师的 verdict

4. **QuickAnalysisResult 类型扩展**: `analyst` 字段从单个 `AnalystReport` 改为 `AnalystReport[]`

### 新增配置字段

`TradingAgentsConfig.models` 保持现有 `analyst` 字段用于所有分析师（共用模型）。后续 Phase 3/4 可按需拆分。

## Plugin Manifest 更新

`openclaw.plugin.json` 的 `skills` 数组新增 6 个目录：

```json
{
  "skills": [
    "./skills/trading-kline",
    "./skills/trading-analysis",
    "./skills/trading-fundamentals",
    "./skills/trading-news",
    "./skills/trading-hot-money",
    "./skills/trading-sentiment",
    "./skills/trading-lockup",
    "./skills/trading-sector"
  ]
}
```

## 类型变更

`src/types.ts` 中的 `QuickAnalysisResult` 改造：

```typescript
// Before
analyst: AnalystReport;

// After
analysts: AnalystReport[];
```

## 测试策略

- 每个 Python 数据脚本：独立测试（mock HTTP 响应）
- Orchestrator：测试并行调用逻辑（mock execPython 和 callLLM）
- 更新现有 integration.test.ts 适配新的 7 分析师流程
- 更新 prompt_loader.test.ts 适配新增 6 个 Prompt 模板

## 文件变更清单

### 新增文件（约 18 个）

- 6 个 Skill 目录各含 `SKILL.md` + `scripts/xxx.py`
- 6 个 Prompt 模板 `skills/trading-analysis/prompts/analysts/*.md`

### 修改文件（约 4 个）

- `src/orchestrator.ts` — 并行数据获取 + 并行分析师调用
- `src/types.ts` — `QuickAnalysisResult.analyst` → `analysts: AnalystReport[]`
- `openclaw.plugin.json` — skills 数组新增 6 个
- `tests/ts/integration.test.ts` — 适配 7 分析师流程

## 参考来源

- Prompt 设计：`trading-agents-reference.md` 中 astock 的 7 个分析师 Prompt
- 数据源实现：TradingAgents-astock 的 `a_stock.py` 函数签名和 HTTP API 地址
- 限速机制：TradingAgents-astock 的东方财富请求保护策略
