---
name: trading-sector
description: Fetch sector/industry data (rankings, concept blocks) for A-share stocks
version: 1.0.0
author: kangjinghang
license: MIT
---

# Trading Sector

Fetch sector and industry data for A-share stocks including industry performance rankings and concept block classifications.

## When to Use

Use this skill when you need to:
- Get industry sector performance rankings
- Get concept/sector block classification for a stock

## Data Sources

1. **Eastmoney push2** — Industry sector performance ranking (90 industries)
2. **百度股市通 (Baidu PAE)** — Concept blocks, industry classification, region

## Usage

```bash
python sector.py --ticker 600519 --date 2026-06-05
```

## Output Format

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "date": "2026-06-05",
    "industry_ranking": [{"name": "白酒", "change_pct": 2.5, "up_count": 15, "down_count": 3, "leader": "贵州茅台"}],
    "concept_blocks": {"概念": [{"name": "白酒", "change_pct": "2.5%"}], "行业": [...]}
  },
  "_source": "eastmoney+baidu"
}
```