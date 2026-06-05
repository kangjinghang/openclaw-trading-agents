---
name: trading-hot-money
description: Fetch hot money data (northbound capital, fund flow, dragon-tiger board) for A-share stocks
version: 1.0.0
author: kangjinghang
license: MIT
---

# Trading Hot Money

Fetch hot money / capital flow data for A-share stocks including northbound capital flow, individual stock fund flow, hot stocks with topic attribution, and dragon-tiger board data.

## When to Use

Use this skill when you need to:
- Get northbound capital flow (沪股通 + 深股通)
- Get individual stock fund flow (main force / large / super large orders)
- Get hot stocks with topic attribution from 同花顺
- Get dragon-tiger board (龙虎榜) appearances

## Data Sources

1. **同花顺 (hexin.cn)** — Northbound capital flow (minute-level)
2. **Eastmoney push2** — Individual stock fund flow
3. **同花顺 (10jqka)** — Hot stocks with reason tags
4. **Eastmoney datacenter** — Dragon-tiger board records

## Usage

```bash
python hot_money.py --ticker 600519 --date 2026-06-05
```

## Output Format

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "date": "2026-06-05",
    "northbound": { "hgt_close": 5.2, "sgt_close": 3.1, "total": 8.3, "signal": "inflow" },
    "fund_flow": { "main_net": 123456.0, "large_net": 89000.0, "super_net": 45000.0 },
    "hot_stocks": [{"code": "000001", "name": "...", "reason": "AI+算力", "change_pct": "10.0"}],
    "dragon_tiger": [{"date": "2026-06-04", "reason": "...", "net_buy": 500.0, "turnover": 5.2}]
  },
  "_source": "eastmoney+10jqka+hexin"
}
```