# 数据源

[English](data-sources.md) | 中文

OpenClaw Trading Agents 使用的 A 股市场数据源。所有数据源均为免费公开接口。

## 总览

| 技能 | 数据类型 | 主源 | 备源 | Python 依赖 |
|------|---------|------|------|------------|
| trading-kline | K 线 OHLCV | mootdx (通达信 TCP 7709) | akshare (新浪 HTTP) | `mootdx`, `akshare` |
| trading-fundamentals | PE/PB/ROE/财务数据 | 腾讯财经 / 东方财富 | mootdx F10 | `mootdx`, `akshare` |
| trading-news | 个股新闻 + 宏观新闻 | 财联社 / 东方财富 | — | `requests`, `akshare` |
| trading-sentiment | 市场情绪 | 东方财富 | — | `akshare` |
| trading-policy | 政策事件 | 东方财富搜索 / 财联社 | — | `requests` |
| trading-hot-money | 北向资金/主力资金/龙虎榜 | 东方财富 | akshare | `akshare`, `requests` |
| trading-lockup | 解禁/内部人交易 | 东方财富 / mootdx F10 | akshare | `mootdx`, `akshare` |
| trading-sector | 行业排名/概念板块 | 东方财富 / 百度 | akshare | `akshare`, `requests` |

## 数据源详情

### K 线数据（`trading-kline`）

```python
# 主源：mootdx（通达信 TCP 协议，最稳定）
from mootdx.quotes import Quotes
client = Quotes.factory(market="std")
df = client.bars(symbol=stock_code, frequency=9, offset=count)

# 备源：akshare（新浪财经 HTTP）
import akshare as ak
df = ak.stock_zh_a_hist(symbol=stock_code, period="daily", adjust="qfq")
```

### 基本面（`trading-fundamentals`）

PE(TTM)、PB、总市值、季度财务数据来自腾讯财经和东方财富。资产负债表/现金流量表/利润表来自新浪财经（通过 akshare）。

### 新闻（`trading-news`）

- 个股新闻：东方财富搜索 API
- 宏观/全球新闻：财联社实时电报 + 东方财富

### 情绪（`trading-sentiment`）

来自东方财富的市场情绪指标，包括恐贪指数、市场宽度、板块轮动信号。

### 政策（`trading-policy`）

- 政策事件：东方财富搜索 API
- 宏观快讯：财联社实时政策公告

### 资金流向（`trading-hot-money`）

- 北向资金（沪股通/深股通）：东方财富 push2 API
- 个股主力资金流向（主力/散户）：东方财富
- 龙虎榜：东方财富，含席位明细

### 解禁（`trading-lockup`）

- 解禁日历 + 影响评估：东方财富
- 内部人交易：mootdx F10

### 行业板块（`trading-sector`）

- 行业排名（90 个行业，含日涨跌幅）：东方财富
- 概念板块（含当日涨跌幅）：百度股市通 + 东方财富

## Fallback 模式

每个数据脚本遵循统一的 fallback 结构：

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
    return {"success": False, "error": f"all sources failed: {last_error}"}
```

## 限流注意事项

- **东方财富**：有请求限速保护，脚本使用 ≥1s 间隔 + 随机抖动 + session 复用。
- **mootdx**：使用 TCP 直连（非 HTTP），更稳定。
- **akshare**：聚合多个数据源（含东方财富），可作为通用备源。
