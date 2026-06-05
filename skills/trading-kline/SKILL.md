---
name: trading-kline
description: Fetch K-line (candlestick/OHLCV) data for A-share stocks with automatic fallback between data sources
version: 1.0.0
author: kangjinghang
license: MIT
---

# Trading K-line

Fetch K-line (candlestick/OHLCV) data for A-share stocks using Python scripts with automatic fallback between data sources.

## When to Use

Use this skill when you need to:
- Fetch historical or current K-line/candlestick data for A-share stocks
- Get OHLCV (Open, High, Low, Close, Volume) data for technical analysis
- Retrieve stock price data with automatic fallback if primary source fails

## Data Sources

This skill uses multiple data sources with automatic fallback:

1. **mootdx** (primary)
   - Uses 通达信 (TDX) TCP protocol
   - Fast and reliable
   - Free access
   - Requires `mootdx>=0.5.7`

2. **akshare** (fallback)
   - Uses 新浪财经 HTTP interface
   - Good backup when mootdx is unavailable
   - Free access
   - Requires `akshare>=1.15`

## Usage

### Command Line Interface

```bash
# Basic usage - fetch 60 data points for stock 600519 (Guizhou Moutai)
python kline.py --ticker 600519 --count 60

# Fetch 30 data points for stock 000001 (Ping An Bank)
python kline.py --ticker 000001 --count 30

# Fetch for Shenzhen market stock (3xx series - ChiNext)
python kline.py --ticker 300750 --count 120
```

### stdin JSON Interface

```bash
# Pass parameters via stdin JSON
echo '{"ticker": "600519", "count": 60}' | python kline.py
```

### TypeScript Integration

The TypeScript plugin can call this script via `exec-python.ts`:

```typescript
const result = await execPython(klineScript, [
  "--ticker", ticker,
  "--count", "60"
]);
```

## Output Format

### Success Response

```json
{
  "success": true,
  "data": {
    "ticker": "600519",
    "count": 60,
    "data": [
      {
        "date": "2024-01-02",
        "open": 1850.00,
        "high": 1880.00,
        "low": 1845.00,
        "close": 1875.50,
        "volume": 2500000,
        "amount": 4680000000
      },
      ...
    ]
  },
  "_source": "mootdx"
}
```

### Error Response

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

## Market Detection

The script automatically detects the market based on ticker code:

- **Shanghai Stock Exchange** (market=1): Tickers starting with `6` or `68`
  - Example: `600519` (Guizhou Moutai), `688981` (STAR Market)

- **Shenzhen Stock Exchange** (market=0): Tickers starting with `0` or `3`
  - Example: `000001` (Ping An Bank), `300750` (ChiNext)

## Requirements

Install required Python packages:

```bash
pip install -r requirements.txt
```

Required packages:
- `mootdx>=0.5.7,<1` - Primary data source
- `akshare>=1.15,<2` - Fallback data source
- `pandas>=2.0,<3` - Data processing
