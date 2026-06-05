#!/usr/bin/env python3
"""Fetch fundamental data for A-share stocks (PE/PB/financials/EPS forecast)."""

import argparse
import json
import sys
import os

# Add parent skills dir to path for shared imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import tencent_quote, em_get, output_json, normalize_ticker


def fetch_fundamentals(ticker, date):
    """Fetch fundamentals from Tencent (valuation) + mootdx (financials) + 同花顺 (EPS)."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    # 1. Tencent: real-time valuation
    try:
        tq = tencent_quote([code])
        if code in tq:
            q = tq[code]
            data["valuation"] = {
                "name": q["name"],
                "price": q["price"],
                "pe_ttm": q["pe_ttm"],
                "pe_static": q["pe_static"],
                "pb": q["pb"],
                "market_cap_yi": q["mcap_yi"],
                "float_market_cap_yi": q["float_mcap_yi"],
                "turnover_pct": q["turnover_pct"],
                "change_pct": q["change_pct"],
            }
    except Exception as e:
        data["valuation_error"] = str(e)

    # 2. mootdx: quarterly financial snapshot
    try:
        from mootdx.quotes import Quotes
        market = 1 if code.startswith("6") else 0
        client = Quotes.factory(market=market, timeout=10)
        fin = client.finance(symbol=int(code))
        if fin is not None and not (hasattr(fin, 'empty') and fin.empty):
            row = fin.iloc[0] if hasattr(fin, 'iloc') else fin
            snapshot = {}
            for field in ["eps", "bvps", "roe", "profit", "income",
                          "liutongguben", "zongguben"]:
                if hasattr(row, 'index') and field in row.index:
                    val = row[field]
                    if val is not None and str(val) != "nan":
                        snapshot[field] = float(val) if not isinstance(val, str) else val
            if snapshot:
                data["financial_snapshot"] = snapshot
    except Exception as e:
        data["financial_snapshot_error"] = str(e)

    # 3. Eastmoney: basic stock info
    try:
        market_code = 1 if code.startswith("6") else 0
        url = "https://push2.eastmoney.com/api/qt/stock/get"
        params = {
            "fltt": "2", "invt": "2",
            "fields": "f57,f58,f84,f85,f127,f116,f117,f189,f43",
            "secid": f"{market_code}.{code}",
        }
        r = em_get(url, params=params, timeout=10)
        d = r.json().get("data", {})
        if d:
            info = {}
            if d.get("f127"):
                info["industry"] = d["f127"]
            if d.get("f84"):
                info["total_shares"] = d["f84"]
            if d.get("f85"):
                info["float_shares"] = d["f85"]
            if d.get("f116"):
                info["total_mv"] = d["f116"]
            if info:
                data["stock_info"] = info
    except Exception as e:
        data["stock_info_error"] = str(e)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch fundamental data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code (e.g., 600519)")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_fundamentals(args.ticker, args.date)
        output_json(True, data=data, source="tencent+mootdx+eastmoney")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()