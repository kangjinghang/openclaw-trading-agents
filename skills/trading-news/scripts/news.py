#!/usr/bin/env python3
"""Fetch stock news (individual + macro/global) for A-share stocks with time-layered categorization."""

import argparse
import json
import sys
import os
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, output_json, normalize_ticker, record_call

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _fetch_news_eastmoney(code, page_size=50):
    """Fetch individual stock news from Eastmoney search API."""
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
        record_call("news/stock_em", success=True,
                    duration_ms=(time.monotonic() - start) * 1000,
                    url=url, status_code=resp.status_code,
                    response_size=len(resp.content),
                    response_snippet=resp.text)
        return articles
    except Exception as e:
        record_call("news/stock_em", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        return []


def _fetch_global_news_akshare(limit=10):
    """Fetch macro/global financial news from akshare (东方财富全球财经快讯).

    Fallback for when CLS is unavailable. akshare.stock_info_global_em returns
    ~200 rows with columns 标题/摘要/发布时间/链接; we map to the same article
    shape the CLS path produces so downstream prompts are source-agnostic.
    Returns an empty list on failure (caller records macro_news_error).
    """
    start = time.monotonic()
    try:
        import akshare as ak
        df = ak.stock_info_global_em()
    except Exception as e:
        record_call("news/macro_akshare", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        raise RuntimeError(f"akshare macro news unavailable: {type(e).__name__}: {e}") from e

    articles = []
    # df may be empty if the upstream is having a bad day — guard before iterating.
    if df is None or len(df) == 0:
        record_call("news/macro_akshare", success=False, error="empty result",
                    duration_ms=(time.monotonic() - start) * 1000)
        return articles
    for _, row in df.head(limit).iterrows():
        title = str(row.get("标题", "") or "")
        content = str(row.get("摘要", "") or "")
        pub_time = str(row.get("发布时间", "") or "")
        articles.append({
            "title": title,
            "content": content[:300],
            "time": pub_time[:16],  # trim to YYYY-MM-DD HH:MM if present
            "source": "东方财富全球",
        })
    record_call("news/macro_akshare", success=True,
                duration_ms=(time.monotonic() - start) * 1000)
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


def _categorize_news(articles, reference_date_str, lookback_days=7):
    """Categorize articles into time layers based on reference date.

    The history layer spans ``lookback_days`` so callers that pass a wider
    window (e.g. the policy role uses --lookback-days 14) actually retain
    older articles instead of always clipping at 7 days. The realtime/extended
    layers (6h / 24h) are fixed regardless of lookback — they describe
    freshness, not the fetch window.
    """
    try:
        ref_date = datetime.strptime(reference_date_str, "%Y-%m-%d")
    except (ValueError, TypeError):
        ref_date = datetime.now()

    now = ref_date.replace(hour=23, minute=59, second=59)
    cutoff_6h = now - timedelta(hours=6)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_history = now - timedelta(days=max(1, lookback_days))

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
        elif pub_time >= cutoff_history:
            layers["history_7d"].append(article)
        else:
            # Older than the lookback window, skip from layers but keep in flat list
            pass

    stats = {
        "realtime_6h_count": len(layers["realtime_6h"]),
        "extended_24h_count": len(layers["extended_24h"]),
        "history_7d_count": len(layers["history_7d"]),
        "total_categorized": sum(len(v) for v in layers.values()),
    }

    return layers, stats


def fetch_news(ticker, date, lookback_days=7, skip_macro=False):
    """Fetch individual stock news + macro news with time-layered categorization.

    skip_macro=True 时跳过宏观新闻拉取（CLS + akshare 两路 HTTP 全省）。
    适用于 shallow-analyzer 这类快筛场景：候选池 N 股各自调用 news.py，
    宏观新闻与 ticker 无关、N 次拉取内容相同纯属浪费，且 shallow 不消费宏观。
    跳过后 macro_news 仍输出空数组 + macro_news_source="skipped"，保持结构稳定。
    """
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date, "lookback_days": lookback_days}

    try:
        articles = _fetch_news_eastmoney(code)
        data["stock_news"] = articles

        # Categorize into time layers (history window = lookback_days)
        layers, stats = _categorize_news(articles, date, lookback_days)
        data["news_layers"] = layers
        data["layer_stats"] = stats
    except Exception as e:
        data["stock_news_error"] = str(e)

    if skip_macro:
        # shallow-analyzer 不消费宏观新闻，跳过宏观拉取（省 N×1 请求）
        data["macro_news"] = []
        data["macro_news_source"] = "skipped"
        return data

    # Macro news: 东方财富全球财经快讯（akshare.stock_info_global_em）。
    # 历史上曾用 CLS 财联社电报作主源 + akshare 兜底，但 CLS 的
    # nodeapi/telegraphList 接口已稳定 404（2026-06 实测 3/3 失败），
    # akshare 的 CLS 实现同 URL 同样失效。现简化为 EM 单源——稳定、
    # 200 条、0.2s。macro_news_source / macro_news_error 保留以维持
    # 输出结构稳定 + 错误可观测。
    macro_source = "none"
    macro_articles = []
    try:
        macro_articles = _fetch_global_news_akshare()
        if macro_articles:
            macro_source = "eastmoney"
        else:
            data["macro_news_error"] = "macro source returned empty"
    except Exception as e:
        data["macro_news_error"] = str(e)

    data["macro_news"] = macro_articles
    data["macro_news_source"] = macro_source

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch news for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    parser.add_argument("--lookback-days", type=int, default=7, help="Days to look back")
    parser.add_argument("--skip-macro", action="store_true",
                        help="Skip macro news fetch (CLS+akshare). For shallow-analyzer "
                             "batch scenarios where macro is unused and per-ticker duplicate.")
    args = parser.parse_args()

    try:
        data = fetch_news(args.ticker, args.date, args.lookback_days,
                          skip_macro=args.skip_macro)
        # Reflect the macro source actually used (cls/akshare/skipped/none) in the
        # top-level _source so it's visible without drilling into data.
        macro_src = data.get("macro_news_source", "none")
        output_json(True, data=data, source=f"eastmoney+{macro_src}")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()