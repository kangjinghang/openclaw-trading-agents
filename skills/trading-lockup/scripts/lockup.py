#!/usr/bin/env python3
"""Fetch lockup expiry and insider transaction data for A-share stocks."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import eastmoney_datacenter, output_json, normalize_ticker


def _fetch_lockup_history(code):
    """Fetch historical lockup expiry records."""
    try:
        data = eastmoney_datacenter(
            "RPT_LIFT_STAGE",
            filter_str=f'(SECURITY_CODE="{code}")',
            page_size=15,
            sort_columns="FREE_DATE",
            sort_types="-1",
        )
        return [
            {"date": str(row.get("FREE_DATE", ""))[:10],
             "type": row.get("LIMITED_STOCK_TYPE", ""),
             "shares": row.get("FREE_SHARES_NUM", ""),
             "ratio": row.get("FREE_RATIO", "")}
            for row in data
        ]
    except Exception:
        return []


def _fetch_lockup_upcoming(code, date, forward_days=90):
    """Fetch upcoming lockup expiries."""
    end_dt = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=forward_days)).strftime("%Y-%m-%d")
    try:
        data = eastmoney_datacenter(
            "RPT_LIFT_STAGE",
            filter_str=f'(SECURITY_CODE="{code}")(FREE_DATE>=\'{date}\')(FREE_DATE<=\'{end_dt}\')',
            page_size=20,
            sort_columns="FREE_DATE",
            sort_types="1",
        )
        return [
            {"date": str(row.get("FREE_DATE", ""))[:10],
             "type": row.get("LIMITED_STOCK_TYPE", ""),
             "shares": row.get("FREE_SHARES_NUM", ""),
             "ratio": row.get("FREE_RATIO", "")}
            for row in data
        ]
    except Exception:
        return []


def _fetch_insider_transactions(code):
    """Fetch insider transactions from mootdx F10."""
    try:
        from mootdx.quotes import Quotes
        market = 1 if code.startswith("6") else 0
        client = Quotes.factory(market=market, timeout=10)
        info = client.f10(symbol=int(code), name="股东变动")
        if info is not None and not (hasattr(info, 'empty') and info.empty):
            rows = []
            for _, row in info.head(10).iterrows():
                rows.append({k: str(v) for k, v in row.items()})
            return rows
    except Exception:
        pass
    return []


def fetch_lockup(ticker, date):
    """Fetch all lockup data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["lockup_history"] = _fetch_lockup_history(code)
    data["lockup_upcoming"] = _fetch_lockup_upcoming(code, date)
    data["insider_transactions"] = _fetch_insider_transactions(code)

    # Compute pressure rating
    upcoming = data.get("lockup_upcoming", [])
    if upcoming:
        data["pressure_rating"] = "重大压力" if len(upcoming) >= 3 else "中等压力" if len(upcoming) >= 1 else "轻微压力"
    else:
        data["pressure_rating"] = "无明显压力"

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch lockup data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_lockup(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney+mootdx")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()