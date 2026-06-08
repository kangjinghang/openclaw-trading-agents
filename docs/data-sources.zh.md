# 数据源

[English](data-sources.md) | 中文

OpenClaw Trading Agents 使用的 A 股市场数据源。所有数据源均为免费公开接口。

## 总览

| 技能 | 数据类型 | 主源 | 备源 | Python 依赖 |
|------|---------|------|------|------------|
| trading-kline | K 线 OHLCV | mootdx (通达信 TCP 7709) | akshare (新浪 HTTP) | `mootdx`, `akshare` |
| trading-fundamentals | PE/PB/ROE/财务数据 | 腾讯财经 / 东方财富 | mootdx F10 | `mootdx`, `akshare` |
| trading-news | 个股新闻 + 宏观新闻 | 财联社 / 东方财富 | — | `requests`, `akshare` |
| trading-sentiment | 市场情绪 / 涨停情绪池 | 东方财富 | akshare (zt_pool) | `akshare` |
| trading-policy | 政策事件 | 东方财富搜索 / 财联社 | — | `requests` |
| trading-hot-money | 北向资金/主力资金/板块资金流/龙虎榜 | 东方财富 | akshare | `akshare`, `requests` |
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

- 热门股排行 / 市场宽度：东方财富 push2
- 个股新闻情绪评分：东方财富搜索 API + 关键词字典打分
- **涨停情绪池（`zt_pool`）**：akshare `stock_zt_pool_em`（底层东方财富 push2ex），含涨停家数、连板梯队分布、龙头高度、标的命中检测；非交易日自动回溯最近交易日

### 政策（`trading-policy`）

- 政策事件：东方财富搜索 API
- 宏观快讯：财联社实时政策公告

### 资金流向（`trading-hot-money`）

- 北向资金（沪股通/深股通）：东方财富 push2 API
- 个股主力资金流向（主力/散户）：东方财富
- 板块资金流排名：行业板块主力净流入 inflow/outflow top8（东方财富 push2 clist）
- 龙虎榜：东方财富，含席位明细

### 解禁（`trading-lockup`）

- 解禁日历 + 影响评估：东方财富
- 内部人交易：mootdx F10

### 行业板块（`trading-sector`）

- 行业排名（90 个行业，含日涨跌幅）：东方财富 `push2` API
- 概念板块：~~百度股市通~~（2026-06 起 API 返回 403），东方财富 `push2` API

> **注意**：`push2.eastmoney.com` 使用流量管理器（负载均衡），会解析到不同 IP。部分网络环境下 IPv6 连接在 TLS 重协商时被服务端断开。共享模块 `http_helpers.py` 已强制 IPv4 DNS 解析作为缓解措施。所有脚本均能优雅处理 API 失败 — 返回空数据而非崩溃。

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

## 已知问题（2026-06）

| 问题 | 影响脚本 | 影响 | 缓解措施 |
|------|---------|------|---------|
| `push2.eastmoney.com` IPv6 TLS 重置 | trading-sector | 行业排名可能返回空数据 | `http_helpers.py` 强制 IPv4；优雅降级返回空数据 |
| 百度股市通 `getrelatedblock` API 返回 403 | trading-sector | 概念板块返回 `null` | 暂无备源；数据省略 |
| 东方财富 `stock_info` 子源报错 | trading-fundamentals | stderr 中出现非关键警告 | 其他子源（腾讯、mootdx）提供等价数据 |

所有脚本使用 `try/except` 包裹 API 调用，对失败的子源返回 `{"success": true, "data": {...}}` 中对应的空数组。即使个别数据源不可用，分析管道仍会继续运行。
