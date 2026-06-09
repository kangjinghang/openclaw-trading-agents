#!/usr/bin/env python3
"""Fetch A-share policy events relevant to a given stock."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, http_get, output_json, normalize_ticker

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _fetch_policy_eastmoney(code, lookback_days=30):
    """Fetch policy-related news from Eastmoney search API."""
    articles = []
    try:
        url = "https://search-api-web.eastmoney.com/search/jsonp"
        inner_param = {
            "uid": "",
            "keyword": code,
            "type": ["cmsArticleWebOld"],
            "client": "web",
            "clientType": "web",
            "clientVersion": "curr",
            "param": {
                "cmsArticleWebOld": {
                    "searchScope": "default",
                    "sort": "default",
                    "pageIndex": 1,
                    "pageSize": 30,
                    "preTag": "",
                    "postTag": "",
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
            "User-Agent": _UA,
        }
        resp = em_get(url, params=params, headers=headers, timeout=15)
        text = resp.text
        text = text[text.index("(") + 1: text.rindex(")")]
        data = json.loads(text)
        cutoff = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
        for item in data.get("result", {}).get("cmsArticleWebOld", []):
            date_str = item.get("date", "")[:10]
            if date_str >= cutoff:
                title = item.get("title", "")
                content = (item.get("content", "") or "")[:300]
                articles.append({
                    "date": date_str,
                    "title": title,
                    "content": content,
                    "source": item.get("mediaName", "东方财富"),
                })
    except Exception:
        pass
    return articles


def _fetch_macro_policy_cls(limit=20):
    """Fetch macro policy telegrams from CLS (财联社)."""
    import requests
    articles = []
    try:
        url = "https://www.cls.cn/nodeapi/telegraphList"
        params = {"rn": str(limit), "page": "1"}
        headers = {"User-Agent": _UA, "Referer": "https://www.cls.cn/"}
        r = http_get(url, params=params, headers=headers, timeout=10)
        d = r.json()
        for item in d.get("data", {}).get("roll_data", []):
            title = item.get("title", "") or item.get("brief", "")
            content = item.get("content", "") or item.get("brief", "")
            ctime = item.get("ctime", "")
            pub_time = ""
            if ctime:
                try:
                    pub_time = datetime.fromtimestamp(int(ctime)).strftime("%Y-%m-%d %H:%M")
                except (ValueError, TypeError, OSError):
                    pub_time = str(ctime)
            articles.append({
                "date": pub_time[:10] if pub_time else "",
                "title": title,
                "content": content[:300],
                "source": "财联社",
            })
    except Exception:
        pass
    return articles


def fetch_policy(ticker, date, lookback_days=30):
    """Fetch policy events for a given stock."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date, "lookback_days": lookback_days}

    try:
        data["stock_policy_news"] = _fetch_policy_eastmoney(code, lookback_days)
    except Exception as e:
        data["stock_policy_error"] = str(e)

    try:
        data["macro_policy_news"] = _fetch_macro_policy_cls()
    except Exception as e:
        data["macro_policy_error"] = str(e)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch policy events for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    parser.add_argument("--lookback-days", type=int, default=30, help="Days to look back")
    args = parser.parse_args()

    try:
        data = fetch_policy(args.ticker, args.date, args.lookback_days)
        output_json(True, data=data, source="eastmoney+cls")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
