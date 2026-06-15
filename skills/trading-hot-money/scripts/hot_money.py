#!/usr/bin/env python3
"""Fetch hot money / capital flow data for A-share stocks (northbound, fund flow, dragon-tiger board)."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, http_get, eastmoney_datacenter, output_json, normalize_ticker, record_error

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
        r = http_get(url, headers=headers, timeout=10)
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
    except Exception as e:
        record_error("northbound", e)
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
    except Exception as e:
        record_error("fund_flow", e)
        return None


def _fetch_hot_stocks(date):
    """Fetch hot stocks with topic attribution from 同花顺."""
    try:
        url = (
            f"http://zx.10jqka.com.cn/event/api/getharden/"
            f"date/{date}/orderby/date/orderway/desc/charset/GBK/"
        )
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36"}
        r = http_get(url, headers=headers, timeout=10)
        data = r.json()
        if data.get("errocode", 0) != 0:
            return None
        rows = data.get("data") or []
        return [
            {"code": row.get("code"), "name": row.get("name"),
             "reason": row.get("reason", ""), "change_pct": row.get("zhangfu", "")}
            for row in rows[:20]
        ]
    except Exception as e:
        record_error("hot_stocks", e)
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
    except Exception as e:
        record_error("dragon_tiger", e)
        return []


def _fetch_sector_fund_flow(top_n=8):
    """Fetch industry board fund-flow ranking (主力净流入) from 东财 push2.

    Board rotation is a primary A-share driver. Returns top-N inflow and
    top-N outflow industry boards so the LLM can read main theme (主线) vs
    weak (弱势) camps. Source: push2 clist fs=m:90+t:2 (行业板块, ~90 boards)
    with f62 (main net inflow), f184 (main net pct), f136 (super-large net).
    """
    url = "https://push2.eastmoney.com/api/qt/clist/get"
    params = {
        "pn": "1", "pz": "100", "po": "1", "np": "1",
        "fltt": "2", "invt": "2",
        "fs": "m:90+t:2",
        "fields": "f3,f12,f14,f62,f136,f184",
    }
    try:
        r = em_get(url, params=params, timeout=15)
        items = r.json().get("data", {}).get("diff", []) or []
    except Exception as e:
        record_error("sector_fund_flow", e)
        return None

    if not items:
        return None

    boards = [
        {
            "name": it.get("f14", ""),
            "change_pct": it.get("f3", 0),
            "main_net_yi": round((it.get("f62") or 0) / 1e8, 2),
            "super_net_yi": round((it.get("f136") or 0) / 1e8, 2),
            "main_net_pct": it.get("f184", 0),
        }
        for it in items
    ]
    boards_sorted = sorted(boards, key=lambda x: x["main_net_yi"], reverse=True)

    return {
        "inflow_top": boards_sorted[:top_n],
        "outflow_top": list(reversed(boards_sorted[-top_n:])),
        "total_boards": len(boards_sorted),
    }


def fetch_hot_money(ticker, date):
    """Fetch all hot money data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["northbound"] = _fetch_northbound()
    data["fund_flow"] = _fetch_fund_flow(code, date)
    data["sector_fund_flow"] = _fetch_sector_fund_flow()
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