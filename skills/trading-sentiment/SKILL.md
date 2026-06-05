---
name: trading-sentiment
description: Fetch market sentiment data (hot stocks, news sentiment) for A-share analysis
version: 1.0.0
author: kangjinghang
license: MIT
---

# Trading Sentiment

Fetch market sentiment data for A-share stocks including hot stock rankings and news sentiment indicators.

## When to Use

Use this skill when you need to:
- Get hot stock rankings from Eastmoney
- Get news articles for sentiment analysis

## Data Sources

1. **Eastmoney push2** — Hot stock rankings
2. **Eastmoney search API** — Stock news for sentiment analysis

## Usage

```bash
python sentiment.py --ticker 600519 --date 2026-06-05
```

## Output Format

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "date": "2026-06-05",
    "hot_rank": [{"code": "000001", "name": "...", "change_pct": 5.2, "price": 12.3}],
    "stock_news": [{"title": "...", "content": "...", "time": "...", "source": "..."}],
    "news_count": 10
  },
  "_source": "eastmoney"
}
```