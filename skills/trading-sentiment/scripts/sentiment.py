#!/usr/bin/env python3
"""Fetch market sentiment data (hot stocks, news sentiment indicators) for A-share analysis."""

import argparse
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, output_json, normalize_ticker


def _fetch_hot_rank(date):
    """Fetch hot stock rankings from Eastmoney."""
    try:
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "pn": "1", "pz": "20", "po": "1", "np": "1",
            "fltt": "2", "invt": "2",
            "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
            "fields": "f2,f3,f4,f12,f14,f104,f105,f127",
        }
        r = em_get(url, params=params, timeout=10)
        d = r.json()
        items = d.get("data", {}).get("diff", [])
        return [
            {"code": item.get("f12"), "name": item.get("f14"),
             "change_pct": item.get("f3", 0), "price": item.get("f2", 0)}
            for item in items[:20]
        ]
    except Exception:
        return None


def _fetch_stock_news_eastmoney(code, page_size=15):
    """Fetch stock news for sentiment analysis."""
    url = "https://search-api-web.eastmoney.com/search/jsonp"
    inner_param = {
        "uid": "", "keyword": code,
        "type": ["cmsArticleWebOld"],
        "client": "web", "clientType": "web", "clientVersion": "curr",
        "param": {
            "cmsArticleWebOld": {
                "searchScope": "default", "sort": "default",
                "pageIndex": 1, "pageSize": page_size,
                "preTag": "", "postTag": "",
            }
        },
    }
    params = {
        "cb": "callback",
        "param": json.dumps(inner_param, ensure_ascii=False),
        "_": "1",
    }
    headers = {
        "Referer": "https://so.eastmoney.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }
    try:
        resp = em_get(url, params=params, headers=headers, timeout=15)
        text = resp.text
        text = text[text.index("(") + 1: text.rindex(")")]
        data = json.loads(text)
        articles = []
        for item in data.get("result", {}).get("cmsArticleWebOld", []):
            articles.append({
                "title": item.get("title", ""),
                "content": (item.get("content", "") or "")[:300],
                "time": item.get("date", ""),
                "source": item.get("mediaName", ""),
            })
        return articles
    except Exception:
        return []


def fetch_sentiment(ticker, date):
    """Fetch sentiment indicators."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["hot_rank"] = _fetch_hot_rank(date)
    data["stock_news"] = _fetch_stock_news_eastmoney(code)
    data["news_count"] = len(data.get("stock_news") or [])

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch sentiment data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_sentiment(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()