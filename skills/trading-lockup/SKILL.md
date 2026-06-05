---
name: trading-lockup
description: Fetch lockup expiry and insider transaction data for A-share stocks
version: 1.0.0
author: kangjinghang
license: MIT
---

# Trading Lockup

Fetch lockup expiry schedule and insider transaction data for A-share stocks.

## When to Use

Use this skill when you need to:
- Get historical lockup expiry records
- Get upcoming lockup expiry schedule (next 90 days)
- Get insider transaction records
- Assess lockup selling pressure

## Data Sources

1. **Eastmoney datacenter** — Lockup expiry history and upcoming schedule
2. **mootdx F10** — Insider transaction records (shareholder changes)

## Usage

```bash
python lockup.py --ticker 600519 --date 2026-06-05
```

## Output Format

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "date": "2026-06-05",
    "lockup_history": [{"date": "2026-01-15", "type": "定增限售", "shares": "5000000", "ratio": "0.4%"}],
    "lockup_upcoming": [],
    "insider_transactions": [],
    "pressure_rating": "无明显压力"
  },
  "_source": "eastmoney+mootdx"
}
```