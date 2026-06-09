#!/usr/bin/env python3
"""Fetch sector/industry data for A-share stocks (industry rankings, concept blocks)."""

import argparse
import json
import sys
import os
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, http_get, output_json, normalize_ticker

import requests


def _fetch_industry_ranking(top_n=30):
    """Fetch industry sector performance ranking from 东财 push2."""
    try:
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "pn": "1", "pz": str(top_n), "po": "1", "np": "1",
            "fltt": "2", "invt": "2",
            "fs": "m:90+t:2",
            "fields": "f2,f3,f4,f12,f13,f14,f104,f105,f128,f136,f140,f141",
        }
        r = em_get(url, params=params, timeout=15)
        d = r.json()
        items = d.get("data", {}).get("diff", [])
        return [
            {"name": item.get("f14"), "change_pct": item.get("f3", 0),
             "up_count": item.get("f104", 0), "down_count": item.get("f105", 0),
             "leader": item.get("f140", "")}
            for item in items
        ]
    except Exception:
        return []


def _fetch_concept_blocks(code):
    """Fetch concept/sector blocks from 百度股市通."""
    try:
        url = (
            f"https://finance.pae.baidu.com/api/getrelatedblock"
            f'?stock=[{{"code":"{code}","market":"ab","type":"stock"}}]'
            f"&finClientType=pc"
        )
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        }
        r = http_get(url, headers=headers, timeout=10)
        d = r.json()
        if str(d.get("ResultCode", -1)) != "0":
            return None
        result = d.get("Result", {})
        categories = result.get(code, [])
        blocks = {}
        for cat in categories:
            cat_name = cat.get("name", "")
            items = cat.get("list", [])
            blocks[cat_name] = [
                {"name": item.get("name", ""), "change_pct": item.get("ratio", "")}
                for item in items
            ]
        return blocks
    except Exception:
        return None


def fetch_sector(ticker, date):
    """Fetch all sector data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["industry_ranking"] = _fetch_industry_ranking()
    data["concept_blocks"] = _fetch_concept_blocks(code)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch sector data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_sector(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney+baidu")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()