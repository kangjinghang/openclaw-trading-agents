# Data Sources Reference — A 股数据源完整参考

> 来源：从 TradingAgents-astock、TradingAgents-AShare、TradingAgents-CN、PanWatch 四个项目中提取。

## 总览

### 各项目数据源对比

| 数据类型 | astock | AShare | CN | PanWatch |
|----------|--------|--------|----|----------|
| K 线/行情 | mootdx (TCP 7709) + 新浪 fallback | akshare | tushare/akshare/baostock | 腾讯 API / 东方财富 |
| 技术指标 | 本地计算 | 本地计算 | 本地计算 | MA/MACD/RSI/KDJ/Boll |
| 基本面 | 腾讯财经 + mootdx + 东方财富 | akshare | tushare | — |
| 一致预期 EPS | 同花顺 (独有) | — | — | — |
| 三大报表 | 新浪财经 | akshare | tushare | — |
| 个股新闻 | 东方财富/新浪 | 多源 | — | 雪球 + 东方财富 |
| 宏观新闻 | 财联社 + 东方财富 | 多源 | — | — |
| 内部人交易 | mootdx F10 | — | — | — |
| 涨停股 + 题材 | 同花顺 (独有 reason tags) | akshare (涨停池) | — | 多源 |
| 北向资金 | 东方财富 (分钟级) | akshare | — | 多源 |
| 概念板块 | 百度股市通 (含当日涨幅) | — | — | — |
| 资金流向 | 东方财富 push2 (分钟级) | akshare | — | 多源 |
| 龙虎榜 | 东方财富 (席位明细) | akshare | — | — |
| 解禁日历 | 东方财富 (含影响评估) | akshare | — | — |
| 行业排名 | 东方财富 (90 个行业) | akshare (板块资金流) | — | — |
| 热门股 | — | 雪球 | — | 多源 |
| 实时行情 | — | — | — | 腾讯 API |

### 推荐数据源组合（astock 为主）

| 数据类型 | 主源 | 备源 | 无 fallback |
|----------|------|------|-------------|
| K 线 | mootdx (TCP 7709) | akshare (新浪) | — |
| 技术指标 | 本地计算 | — | 不需要 |
| 基本面 (PE/PB/市值) | 腾讯财经 | mootdx F10 | — |
| 三大报表 | 新浪财经 | mootdx | — |
| 一致预期 EPS | 同花顺 | — | ✅ 无免费替代 |
| 个股新闻 | 财联社 | 东方财富 | — |
| 宏观新闻 | 财联社 | 东方财富 | — |
| 内部人交易 | mootdx F10 | 东方财富 | — |
| 涨停股 + 题材 | 同花顺 | 东方财富 | — |
| 北向资金 | 东方财富 push2 | akshare | — |
| 概念板块 | 百度股市通 | 东方财富 | — |
| 资金流向 | 东方财富 push2 | akshare | — |
| 龙虎榜 | 东方财富 | akshare | — |
| 解禁日历 | 东方财富 | akshare | — |
| 行业排名 | 东方财富 | akshare | — |

注：akshare 本身聚合了多个数据源（包括东方财富），可作为通用备源。

## 详细函数签名

### astock 数据源（最全，全部免费）

#### K 线数据
```python
# 主源: mootdx (通达信 TCP 7709)
from mootdx.quotes import Quotes
client = Quotes.factory(market="std")
df = client.bars(symbol=stock_code, frequency=9, offset=count)  # 9=日线

# 备源: akshare (新浪财经 HTTP)
import akshare as ak
df = ak.stock_zh_a_hist(symbol=stock_code, period="daily", adjust="qfq")
```

#### 技术指标（本地计算）
```python
# 输入: OHLCV DataFrame
# 输出: close_50_sma, close_200_sma, close_10_ema, macd, macds, macdh, rsi, boll, boll_ub, boll_lb, atr, vwma
# 使用 stockstats 库计算
```

#### 基本面
```python
# 主源: 腾讯财经 + mootdx + 东方财富
get_fundamentals(ticker)  # → PE(TTM), PB, 总市值, 季报财务快照, 一致预期EPS
get_profit_forecast(ticker)  # → 同花顺机构一致预期EPS详情
get_balance_sheet(ticker)  # → 新浪财经资产负债表
get_cashflow(ticker)  # → 新浪财经现金流量表
get_income_statement(ticker)  # → 新浪财经利润表
get_industry_comparison(ticker, curr_date)  # → 东方财富 90个行业涨跌幅/成交额/净流入排名
```

#### 新闻
```python
# 主源: 财联社(最快) > 东方财富(广泛)
get_news(query, start_date, end_date)  # → 东方财富/新浪个股新闻
get_global_news(curr_date, look_back_days, limit)  # → 财联社+东方财富宏观/全球财经新闻
```

#### 游资/资金流向
```python
# 东方财富请求有限速保护（≥1s 间隔 + 随机抖动 + session 复用）
get_hot_stocks(curr_date)  # → 同花顺涨停股 + 题材归因 reason tags (独有)
get_northbound_flow(curr_date)  # → 东方财富北向资金分钟级流向 (沪股通+深股通)
get_concept_blocks(ticker)  # → 百度股市通概念板块/行业分类/地域 (含当日涨幅)
get_fund_flow(ticker, curr_date)  # → 东方财富个股主力/散户资金流向 (分钟级实时+20日历史)
get_dragon_tiger_board(ticker, curr_date)  # → 东方财富龙虎榜上榜记录、买卖席位明细
```

#### 解禁
```python
get_insider_transactions(ticker)  # → mootdx F10 股东/内部人交易
get_lockup_expiry(ticker, curr_date)  # → 东方财富限售解禁日历 + 影响评估
```

### AShare 数据源
```python
# 基于 akshare
get_board_fund_flow(date)  # → 行业板块资金流向排名
get_individual_fund_flow(ticker)  # → 个股主力资金流向
get_lhb_detail(date)  # → 龙虎榜详情
get_zt_pool(date)  # → 涨停板情绪池
get_hot_stocks_xq()  # → 雪球热门股列表

# 并发控制：5 并发上限，3 槽给定时任务，2 槽给实时请求，僵尸线程清理
```

### CN 数据源
```python
# 多源优先级 + 自动 fallback
get_china_stock_data_unified(ticker)  # → tushare/akshare/baostock 可切换
get_china_stock_info_unified(ticker)  # → 同上
switch_china_data_source(source)  # → 运行时切换数据源
```

### PanWatch 数据源
```python
get_index_data()  # → 腾讯 API 市场指数
get_quote_data(ticker)  # → 腾讯 API 个股实时行情
fetch_news(ticker)  # → 雪球 + 东方财富 (5分钟缓存)
get_klines(ticker)  # → Stooq(美股) / 东方财富(A股港股)
capture_batch(ticker)  # → Playwright + 新浪/雪球/东方财富 K线截图 (多模态)
```

## Fallback 通用模式

每个数据脚本的统一结构：

```python
SOURCES = [
    {"name": "eastmoney", "fetch": fetch_from_eastmoney, "priority": 1},
    {"name": "akshare",   "fetch": fetch_from_akshare,   "priority": 2},
]

def fetch(ticker, **params):
    last_error = None
    for source in sorted(SOURCES, key=lambda s: s["priority"]):
        try:
            result = source["fetch"](ticker, **params)
            result["_source"] = source["name"]
            return result
        except Exception as e:
            logger.warning(f"{source['name']} failed: {e}")
            last_error = e
    raise DataFetchError(f"all sources failed: {last_error}")
```

## 限流注意事项

- 东方财富请求有限速保护：≥1s 间隔 + 随机抖动 + session 复用
- AShare 并发控制：5 并发上限，3 槽给定时任务，2 槽给实时请求
- 同花顺数据源无 API 限流问题（爬虫方式获取）
- mootdx 使用 TCP 直连（非 HTTP），更稳定
