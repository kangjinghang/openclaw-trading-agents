#!/usr/bin/env python3
"""
K-line (OHLCV) data fetcher for A-share stocks.
Supports mootdx (primary) and akshare (fallback) data sources.
"""

import sys
import json
import argparse
from typing import Dict, Any, Optional


class DataFetchError(Exception):
    """Exception raised when data fetch fails from all sources."""
    pass


def detect_market(ticker: str) -> int:
    """
    Detect market from ticker code.

    Args:
        ticker: Stock ticker code (e.g., "600519", "000001")

    Returns:
        1 for Shanghai (6xx, 68x), 0 for Shenzhen (0xx, 3xx)
    """
    if ticker.startswith('6') or ticker.startswith('68'):
        return 1  # Shanghai
    elif ticker.startswith('0') or ticker.startswith('3'):
        return 0  # Shenzhen
    else:
        raise DataFetchError(f"Unknown ticker format: {ticker}")


def fetch_from_mootdx(ticker: str, count: int) -> Dict[str, Any]:
    """
    Fetch K-line data from mootdx.

    Args:
        ticker: Stock ticker code
        count: Number of data points to fetch

    Returns:
        Dictionary with OHLCV data
    """
    try:
        from mootdx.quotes import Quotes

        market = detect_market(ticker)

        # Create quotes client
        quotes = Quotes.factory(market=market, timeout=10)

        # category=9 = daily bars; mootdx expects symbol as string
        df = quotes.bars(symbol=ticker, category=9, start=0, offset=count)

        if df is None or (hasattr(df, 'empty') and df.empty):
            raise DataFetchError(f"No data returned from mootdx for {ticker}")

        # Convert to standard format
        data = {
            "ticker": ticker,
            "count": len(df),
            "data": []
        }

        for _, row in df.iterrows():
            data["data"].append({
                "date": str(row.get('datetime', '')),
                "open": float(row.get('open', 0)),
                "high": float(row.get('high', 0)),
                "low": float(row.get('low', 0)),
                "close": float(row.get('close', 0)),
                "volume": float(row.get('vol', 0)),
                "amount": float(row.get('amount', 0))
            })

        return data

    except ImportError:
        raise DataFetchError("mootdx not installed")
    except Exception as e:
        raise DataFetchError(f"mootdx fetch failed: {str(e)}")


def fetch_from_akshare(ticker: str, count: int) -> Dict[str, Any]:
    """
    Fetch K-line data from akshare (fallback).

    Args:
        ticker: Stock ticker code
        count: Number of data points to fetch

    Returns:
        Dictionary with OHLCV data
    """
    try:
        import akshare as ak

        # akshare expects full ticker code with suffix
        # Shanghai: 600519 -> sh600519
        # Shenzhen: 000001 -> sz000001
        market = detect_market(ticker)
        if market == 1:
            symbol = f"sh{ticker}"
        else:
            symbol = f"sz{ticker}"

        # Fetch stock data using akshare
        df = ak.stock_zh_a_hist(symbol=symbol, period="daily",
                                start_date="19700101", adjust="qfq")

        if df is None or df.empty:
            raise DataFetchError(f"No data returned from akshare for {ticker}")

        # Take the most recent `count` records
        df = df.tail(count)

        # Convert to standard format
        data = {
            "ticker": ticker,
            "count": len(df),
            "data": []
        }

        for _, row in df.iterrows():
            data["data"].append({
                "date": str(row.get('日期', '')),
                "open": float(row.get('开盘', 0)),
                "high": float(row.get('最高', 0)),
                "low": float(row.get('最低', 0)),
                "close": float(row.get('收盘', 0)),
                "volume": float(row.get('成交量', 0)),
                "amount": float(row.get('成交额', 0))
            })

        return data

    except ImportError:
        raise DataFetchError("akshare not installed")
    except Exception as e:
        raise DataFetchError(f"akshare fetch failed: {str(e)}")


# Source priority list
SOURCES = ["mootdx", "akshare"]


def fetch(ticker: str, count: int = 60) -> Dict[str, Any]:
    """
    Fetch K-line data with automatic fallback.

    Args:
        ticker: Stock ticker code
        count: Number of data points to fetch (default: 60)

    Returns:
        Dictionary with success status and data/error info
    """
    last_error = None

    for source in SOURCES:
        try:
            if source == "mootdx":
                data = fetch_from_mootdx(ticker, count)
            elif source == "akshare":
                data = fetch_from_akshare(ticker, count)
            else:
                continue

            return {
                "success": True,
                "data": data,
                "_source": source
            }
        except DataFetchError as e:
            last_error = str(e)
            continue
        except Exception as e:
            last_error = str(e)
            continue

    # All sources failed
    return {
        "success": False,
        "error": last_error or "All data sources failed"
    }


def parse_stdin() -> Optional[Dict[str, Any]]:
    """
    Parse JSON input from stdin.

    Returns:
        Parsed dictionary or None if no stdin input
    """
    try:
        if not sys.stdin.isatty():
            stdin_data = sys.stdin.read().strip()
            if stdin_data:
                return json.loads(stdin_data)
    except Exception:
        pass
    return None


def main():
    """Main entry point for CLI usage."""
    parser = argparse.ArgumentParser(description="Fetch K-line data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code (e.g., 600519)")
    parser.add_argument("--date", default="", help="Analysis date YYYY-MM-DD (unused by kline)")
    parser.add_argument("--count", type=int, default=60, help="Number of data points (default: 60)")

    # Try to parse from stdin first
    stdin_input = parse_stdin()
    if stdin_input:
        ticker = stdin_input.get("ticker")
        count = stdin_input.get("count", 60)
        if ticker:
            result = fetch(ticker, count)
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(0 if result["success"] else 1)

    # Parse command line arguments
    args = parser.parse_args()
    result = fetch(args.ticker, args.count)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()
