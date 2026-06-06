# Data Sources

English | [中文](data-sources.zh.md)

A-share market data sources used by OpenClaw Trading Agents. All sources are free and publicly accessible.

## Overview

| Skill | Data Type | Primary Source | Fallback | Python Dependencies |
|-------|-----------|---------------|----------|-------------------|
| trading-kline | K-line OHLCV | mootdx (TDX TCP 7709) | akshare (Sina HTTP) | `mootdx`, `akshare` |
| trading-fundamentals | PE/PB/ROE/Financials | Tencent Finance / Eastmoney | mootdx F10 | `mootdx`, `akshare` |
| trading-news | Stock news + Macro news | CLS (财联社) / Eastmoney | — | `requests`, `akshare` |
| trading-sentiment | Market sentiment | Eastmoney | — | `akshare` |
| trading-policy | Policy events | Eastmoney search / CLS | — | `requests` |
| trading-hot-money | Northbound/Fund flow/Dragon-Tiger | Eastmoney | akshare | `akshare`, `requests` |
| trading-lockup | Lockup/Insider | Eastmoney / mootdx F10 | akshare | `mootdx`, `akshare` |
| trading-sector | Industry ranking/Concepts | Eastmoney / Baidu | akshare | `akshare`, `requests` |

## Data Source Details

### K-line Data (`trading-kline`)

```python
# Primary: mootdx (TDX TCP protocol, most stable)
from mootdx.quotes import Quotes
client = Quotes.factory(market="std")
df = client.bars(symbol=stock_code, frequency=9, offset=count)

# Fallback: akshare (Sina Finance HTTP)
import akshare as ak
df = ak.stock_zh_a_hist(symbol=stock_code, period="daily", adjust="qfq")
```

### Fundamentals (`trading-fundamentals`)

PE(TTM), PB, total market cap, quarterly financials from Tencent Finance and Eastmoney. Balance sheet / cash flow / income statement from Sina Finance via akshare.

### News (`trading-news`)

- Stock-specific news: Eastmoney search API
- Macro/global news: CLS (财联社) real-time telegrams + Eastmoney

### Sentiment (`trading-sentiment`)

Market sentiment indicators from Eastmoney including fear/greed index, market breadth, and sector rotation signals.

### Policy (`trading-policy`)

- Policy events: Eastmoney search API
- Macro telegrams: CLS (财联社) real-time policy announcements

### Capital Flow (`trading-hot-money`)

- Northbound capital flow (沪股通/深股通): Eastmoney push2 API
- Individual stock fund flow (主力/散户): Eastmoney
- Dragon-Tiger board (龙虎榜): Eastmoney with seat details

### Lockup (`trading-lockup`)

- Lockup expiry calendar with impact assessment: Eastmoney
- Insider transactions: mootdx F10

### Sector (`trading-sector`)

- Industry ranking (90 sectors with daily performance): Eastmoney `push2` API
- Concept blocks: ~~Baidu Stock~~ (API returns 403 as of 2026-06), Eastmoney `push2` API

> **Note**: `push2.eastmoney.com` uses a traffic manager (load balancer) that may route to different IPs. In some network environments, IPv6 connections are dropped during TLS renegotiation. The shared `http_helpers.py` module forces IPv4 DNS resolution as a mitigation. All scripts handle API failures gracefully — returning empty data instead of crashing.

## Fallback Pattern

Each data script follows a unified fallback structure:

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

## Rate Limiting Notes

- **Eastmoney**: Rate-limited. Scripts use ≥1s interval + random jitter + session reuse.
- **mootdx**: Uses TCP direct connection (not HTTP), more stable.
- **akshare**: Aggregates multiple sources including Eastmoney. Acts as universal fallback.

## Known Issues (2026-06)

| Issue | Affected Scripts | Impact | Mitigation |
|-------|-----------------|--------|------------|
| `push2.eastmoney.com` IPv6 TLS reset | trading-sector | Industry ranking may return empty | IPv4 forced in `http_helpers.py`; graceful empty fallback |
| Baidu Stock `getrelatedblock` API 403 | trading-sector | Concept blocks return `null` | No fallback available; data simply omitted |
| Eastmoney `stock_info` sub-source error | trading-fundamentals | Non-critical warning in stderr | Other sub-sources (tencent, mootdx) provide equivalent data |

All scripts wrap API calls in `try/except` and return `{"success": true, "data": {...}}` with empty arrays for failed sub-sources. The analysis pipeline continues even when individual data sources are unavailable.
