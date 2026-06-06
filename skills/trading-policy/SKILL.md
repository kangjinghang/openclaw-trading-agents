# trading-policy

Fetch A-share policy events relevant to a given stock.

## Scripts

- `scripts/policy.py` — Fetches policy-related news from Eastmoney search API + CLS macro telegrams.

### Usage

```bash
python3 scripts/policy.py --ticker 600519 --date 2026-06-05 --lookback-days 30
```
