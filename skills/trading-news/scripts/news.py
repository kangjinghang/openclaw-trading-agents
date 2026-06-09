#!/usr/bin/env python3
"""Fetch stock news (individual + macro/global) for A-share stocks with time-layered categorization."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, http_get, output_json, normalize_ticker

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _fetch_news_eastmoney(code, page_size=50):
    """Fetch individual stock news from Eastmoney search API."""
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
                "pageSize": page_size,
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
                "source": item.get("mediaName", "东方财富"),
            })
        return articles
    except Exception:
        return []


def _fetch_global_news_cls(limit=10):
    """Fetch macro/global financial news from CLS (财联社快讯)."""
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
                "title": title,
                "content": content[:300],
                "time": pub_time,
                "source": "财联社",
            })
    except Exception:
        pass
    return articles


def _parse_news_time(time_str):
    """Parse news time string into datetime. Returns None if parsing fails."""
    if not time_str:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y年%m月%d日 %H:%M"):
        try:
            return datetime.strptime(time_str.strip(), fmt)
        except ValueError:
            continue
    return None


def _categorize_news(articles, reference_date_str):
    """Categorize articles into time layers based on reference date."""
    try:
        ref_date = datetime.strptime(reference_date_str, "%Y-%m-%d")
    except (ValueError, TypeError):
        ref_date = datetime.now()

    now = ref_date.replace(hour=23, minute=59, second=59)
    cutoff_6h = now - timedelta(hours=6)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=7)

    layers = {
        "realtime_6h": [],
        "extended_24h": [],
        "history_7d": [],
    }

    for article in articles:
        pub_time = _parse_news_time(article.get("time", ""))
        if pub_time is None:
            layers["history_7d"].append(article)
            continue

        if pub_time >= cutoff_6h:
            layers["realtime_6h"].append(article)
        elif pub_time >= cutoff_24h:
            layers["extended_24h"].append(article)
        elif pub_time >= cutoff_7d:
            layers["history_7d"].append(article)
        else:
            # Older than 7 days, skip from layers but keep in flat list
            pass

    stats = {
        "realtime_6h_count": len(layers["realtime_6h"]),
        "extended_24h_count": len(layers["extended_24h"]),
        "history_7d_count": len(layers["history_7d"]),
        "total_categorized": sum(len(v) for v in layers.values()),
    }

    return layers, stats


def fetch_news(ticker, date, lookback_days=7):
    """Fetch individual stock news + macro news with time-layered categorization."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date, "lookback_days": lookback_days}

    try:
        articles = _fetch_news_eastmoney(code)
        data["stock_news"] = articles

        # Categorize into time layers
        layers, stats = _categorize_news(articles, date)
        data["news_layers"] = layers
        data["layer_stats"] = stats
    except Exception as e:
        data["stock_news_error"] = str(e)

    try:
        data["macro_news"] = _fetch_global_news_cls()
    except Exception as e:
        data["macro_news_error"] = str(e)

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch news for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    parser.add_argument("--lookback-days", type=int, default=7, help="Days to look back")
    args = parser.parse_args()

    try:
        data = fetch_news(args.ticker, args.date, args.lookback_days)
        output_json(True, data=data, source="eastmoney+cls")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()