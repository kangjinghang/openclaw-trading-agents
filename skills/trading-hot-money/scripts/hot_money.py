#!/usr/bin/env python3
"""Fetch hot money / capital flow data for A-share stocks (northbound, fund flow, dragon-tiger board)."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, eastmoney_datacenter, output_json, normalize_ticker

import requests


def _fetch_northbound():
    """Fetch northbound capital flow from 同花顺 hsgtApi."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36",
        "Host": "data.hexin.cn",
        "Referer": "https://data.hexin.cn/",
    }
    try:
        url = "https://data.hexin.cn/market/hsgtApi/method/dayChart/"
        r = requests.get(url, headers=headers, timeout=10)
        d = r.json()
        times = d.get("time", [])
        hgt = d.get("hgt", [])
        sgt = d.get("sgt", [])
        if not times:
            return None
        hgt_close = float(hgt[-1]) if hgt else 0
        sgt_close = float(sgt[-1]) if sgt else 0
        return {
            "hgt_close": hgt_close,
            "sgt_close": sgt_close,
            "total": hgt_close + sgt_close,
            "signal": "inflow" if (hgt_close + sgt_close) > 0 else "outflow",
            "recent_points": [
                {"time": times[i], "hgt": float(hgt[i]) if i < len(hgt) else 0,
                 "sgt": float(sgt[i]) if i < len(sgt) else 0}
                for i in range(max(0, len(times) - 10), len(times))
            ],
        }
    except Exception:
        return None


def _fetch_fund_flow(code, date):
    """Fetch individual stock fund flow from 东财 push2."""
    secid = f"1.{code}" if code.startswith("6") else f"0.{code}"
    try:
        url = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get"
        params = {
            "secid": secid, "klt": 1,
            "fields1": "f1,f2,f3,f7",
            "fields2": "f51,f52,f53,f54,f55,f56,f57",
        }
        r = em_get(url, params=params, timeout=10)
        d = r.json()
        klines = d.get("data", {}).get("klines", [])
        if not klines:
            return None
        last = klines[-1].split(",")
        result = {"main_net": float(last[1]) if len(last) > 1 else 0}
        if len(last) >= 6:
            result["large_net"] = float(last[4])
            result["super_net"] = float(last[5])
        return result
    except Exception:
        return None


def _fetch_hot_stocks(date):
    """Fetch hot stocks with topic attribution from 同花顺."""
    try:
        url = (
            f"http://zx.10jqka.com.cn/event/api/getharden/"
            f"date/{date}/orderby/date/orderway/desc/charset/GBK/"
        )
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36"}
        r = requests.get(url, headers=headers, timeout=10)
        data = r.json()
        if data.get("errocode", 0) != 0:
            return None
        rows = data.get("data") or []
        return [
            {"code": row.get("code"), "name": row.get("name"),
             "reason": row.get("reason", ""), "change_pct": row.get("zhangfu", "")}
            for row in rows[:20]
        ]
    except Exception:
        return None


def _fetch_dragon_tiger(code, date, lookback=30):
    """Fetch dragon-tiger board appearances with buy/sell amounts."""
    start_dt = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=lookback)).strftime("%Y-%m-%d")
    try:
        data = eastmoney_datacenter(
            "RPT_DAILYBILLBOARD_DETAILSNEW",
            filter_str=f'(TRADE_DATE>=\'{start_dt}\')(TRADE_DATE<=\'{date}\')(SECURITY_CODE="{code}")',
            page_size=10,
            sort_columns="TRADE_DATE",
            sort_types="-1",
        )
        if not data:
            return []
        return [
            {
                "date": str(row.get("TRADE_DATE", ""))[:10],
                "reason": row.get("EXPLANATION", ""),
                "net_buy": round((row.get("BILLBOARD_NET_AMT") or 0) / 10000, 1),
                "buy_amt": round((row.get("BILLBOARD_BUY_AMT") or 0) / 10000, 1),
                "sell_amt": round((row.get("BILLBOARD_SELL_AMT") or 0) / 10000, 1),
                "turnover": round(float(row.get("TURNOVERRATE") or 0), 2),
                "close_price": round(float(row.get("CLOSE_PRICE") or 0), 2),
                "change_rate": round(float(row.get("CHANGE_RATE") or 0), 2),
            }
            for row in data
        ]
    except Exception:
        return []


def fetch_hot_money(ticker, date):
    """Fetch all hot money data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["northbound"] = _fetch_northbound()
    data["fund_flow"] = _fetch_fund_flow(code, date)
    data["hot_stocks"] = _fetch_hot_stocks(date)
    data["dragon_tiger"] = _fetch_dragon_tiger(code, date)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch hot money data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_hot_money(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney+10jqka+hexin")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()