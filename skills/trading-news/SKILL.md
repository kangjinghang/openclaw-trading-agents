---
name: trading-news
description: Fetch stock news (individual + macro/global) for A-share stocks
version: 1.0.0
author: kangjinghang
license: MIT
---

# Trading News

Fetch news data for A-share stocks including individual stock news and macro/global financial news.

## When to Use

Use this skill when you need to:
- Get individual stock news from Eastmoney
- Get macro/global financial news from CLS (财联社)

## Data Sources

1. **Eastmoney** — Individual stock news via search API
2. **财联社 (CLS)** — Macro/global financial news wire

## Usage

```bash
python news.py --ticker 600519 --date 2026-06-05
python news.py --ticker 600519 --date 2026-06-05 --lookback-days 14
```

## Output Format

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "date": "2026-06-05",
    "lookback_days": 7,
    "stock_news": [{"title": "...", "content": "...", "time": "...", "source": "东方财富"}],
    "macro_news": [{"title": "...", "content": "...", "time": "...", "source": "财联社"}]
  },
  "_source": "eastmoney+cls"
}
```