#!/usr/bin/env python3
"""Fetch A-share policy events relevant to a given stock."""

import argparse
import json
import sys
import os
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, http_get, output_json, normalize_ticker, record_call

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _fetch_policy_eastmoney(code, lookback_days=30):
    """Fetch policy-related news from Eastmoney search API."""
    start = time.monotonic()
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
        record_call("policy/stock_em", success=True,
                    duration_ms=(time.monotonic() - start) * 1000)
        return articles
    except Exception as e:
        record_call("policy/stock_em", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        return []


def _fetch_macro_policy_cls(limit=20):
    """Fetch macro policy telegrams from CLS (财联社).

    Raises on failure (instead of the old bare except: pass) so fetch_policy
    can record the reason and fall back to akshare. A silent CLS outage would
    otherwise leave macro_policy_news empty for days with no signal.
    """
    start = time.monotonic()
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
        record_call("policy/macro_cls", success=True,
                    duration_ms=(time.monotonic() - start) * 1000)
        return articles
    except Exception as e:
        record_call("policy/macro_cls", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        raise RuntimeError(f"CLS macro policy unavailable: {type(e).__name__}: {e}") from e


def _fetch_macro_policy_akshare(limit=20):
    """Fetch macro policy telegrams from akshare (东方财富全球财经快讯).

    Fallback for when CLS is unavailable. Returns articles in the same shape
    as the CLS path (date/title/content/source). Raises on failure so the
    caller can record macro_policy_error.
    """
    start = time.monotonic()
    try:
        import akshare as ak
        df = ak.stock_info_global_em()
    except Exception as e:
        record_call("policy/macro_akshare", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        raise RuntimeError(f"akshare macro policy unavailable: {type(e).__name__}: {e}") from e

    articles = []
    # df may be empty if the upstream is having a bad day — guard before iterating.
    if df is None or len(df) == 0:
        record_call("policy/macro_akshare", success=False, error="empty result",
                    duration_ms=(time.monotonic() - start) * 1000)
        return articles
    for _, row in df.head(limit).iterrows():
        title = str(row.get("标题", "") or "")
        content = str(row.get("摘要", "") or "")
        pub_time = str(row.get("发布时间", "") or "")
        articles.append({
            "date": pub_time[:10] if pub_time else "",
            "title": title,
            "content": content[:300],
            "source": "东方财富全球",
        })
    record_call("policy/macro_akshare", success=True,
                duration_ms=(time.monotonic() - start) * 1000)
    return articles


def fetch_policy(ticker, date, lookback_days=30):
    """Fetch policy events for a given stock."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date, "lookback_days": lookback_days}

    try:
        data["stock_policy_news"] = _fetch_policy_eastmoney(code, lookback_days)
    except Exception as e:
        data["stock_policy_error"] = str(e)

    # Macro policy: try CLS first, fall back to akshare. Record which source we
    # used and any error so a silent CLS outage is observable (it previously
    # left macro_policy_news empty for days via a bare except: pass).
    macro_source = "none"
    macro_articles = []
    try:
        macro_articles = _fetch_macro_policy_cls()
        if macro_articles:
            macro_source = "cls"
    except Exception as e:
        data["macro_policy_error"] = str(e)

    if not macro_articles:
        try:
            macro_articles = _fetch_macro_policy_akshare()
            if macro_articles:
                macro_source = "akshare"
            elif "macro_policy_error" not in data:
                data["macro_policy_error"] = "all macro sources returned empty"
        except Exception as e:
            existing = data.get("macro_policy_error")
            data["macro_policy_error"] = f"{existing}; akshare: {e}" if existing else str(e)

    data["macro_policy_news"] = macro_articles
    data["macro_policy_source"] = macro_source

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch policy events for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    parser.add_argument("--lookback-days", type=int, default=30, help="Days to look back")
    args = parser.parse_args()

    try:
        data = fetch_policy(args.ticker, args.date, args.lookback_days)
        macro_src = data.get("macro_policy_source", "none")
        output_json(True, data=data, source=f"eastmoney+{macro_src}")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()
