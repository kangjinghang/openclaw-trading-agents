---
name: trading-fundamentals
description: Fetch fundamental data (PE/PB/market cap/financials) for A-share stocks
version: 1.0.0
author: kangjinghang
license: MIT
---

# Trading Fundamentals

Fetch fundamental data for A-share stocks including valuation metrics, financial snapshots, and stock info.

## When to Use

Use this skill when you need to:
- Get PE/PB/market cap valuation data
- Retrieve quarterly financial snapshots (EPS, ROE, revenue, profit)
- Get basic stock info (industry, shares outstanding)

## Data Sources

1. **Tencent Finance** (primary) — Real-time PE/PB/market cap/turnover
2. **mootdx** — Quarterly financial snapshot (EPS, ROE, etc.)
3. **Eastmoney** — Basic stock info (industry, shares)

## Usage

```bash
python fundamentals.py --ticker 600519 --date 2026-06-05
```

## Output Format

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "date": "2026-06-05",
    "valuation": { "name": "贵州茅台", "pe_ttm": 25.3, "pb": 8.1, ... },
    "financial_snapshot": { "eps": 42.5, "roe": 30.2, ... },
    "stock_info": { "industry": "白酒", "total_shares": 1256197890, ... }
  },
  "_source": "tencent+mootdx+eastmoney"
}
```