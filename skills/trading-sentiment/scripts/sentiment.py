#!/usr/bin/env python3
"""Fetch market sentiment data (hot stocks, news sentiment indicators) for A-share analysis."""

import argparse
import json
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, output_json, normalize_ticker, record_call
from iwencai_client import get_client as get_iwencai_client


# ── Sentiment keyword dictionaries ──────────────────────────────

_POSITIVE_WORDS = [
    "利好", "上涨", "涨停", "大涨", "暴涨", "突破", "新高", "业绩大增", "超预期",
    "增持", "回购", "分红", "纳入", "中标", "签约", "获批", "合作", "创新高",
    "景气", "增长", "盈利", "翻倍", "扭亏", "龙头", "强势", "资金流入", "反弹",
    "看好", "推荐", "买入", "升级", "催化", "加速", "扩张", "订单", "放量上涨",
    "政策利好", "降准", "降息", "扶持", "补贴", "刺激",
]

_NEGATIVE_WORDS = [
    "利空", "下跌", "跌停", "大跌", "暴跌", "新低", "亏损", "下滑", "减持",
    "质押", "违规", "处罚", "退市", "风险", "警示", "警告", "诉讼", "仲裁",
    "业绩下滑", "不及预期", "商誉减值", "爆雷", "违约", "清仓", "资金流出",
    "恐慌", "抛售", "看空", "下调", "降级", "收紧", "调控", "限制", "缩量下跌",
    "监管", "问询", "立案", "冻结", "查封", "强制",
]


def _score_sentiment(articles):
    """Score news sentiment using keyword matching. Returns score, label, and counts."""
    positive_count = 0
    negative_count = 0
    neutral_count = 0

    for article in articles:
        title = article.get("title", "")
        content = article.get("content", "")
        text = f"{title} {content}"

        pos_hits = sum(1 for w in _POSITIVE_WORDS if w in text)
        neg_hits = sum(1 for w in _NEGATIVE_WORDS if w in text)

        if pos_hits > neg_hits:
            positive_count += 1
        elif neg_hits > pos_hits:
            negative_count += 1
        else:
            neutral_count += 1

    total = len(articles)
    if total == 0:
        return {"score": 0.0, "label": "中性", "positive": 0, "negative": 0, "neutral": 0}

    # Score: normalized to [-1, +1]
    score = (positive_count - negative_count) / total

    # Label
    if score > 0.5:
        label = "乐观"
    elif score > 0.2:
        label = "偏乐观"
    elif score > -0.2:
        label = "中性"
    elif score > -0.5:
        label = "偏悲观"
    else:
        label = "悲观"

    return {
        "score": round(score, 3),
        "label": label,
        "positive": positive_count,
        "negative": negative_count,
        "neutral": neutral_count,
        "total": total,
    }


def _check_hot_rank_position(hot_rank, code):
    """Check if the stock appears in hot rankings and return its position."""
    if not hot_rank:
        return None
    for i, item in enumerate(hot_rank):
        if item.get("code") == code:
            return {
                "rank": i + 1,
                "name": item.get("name", ""),
                "change_pct": item.get("change_pct", 0),
            }
    return None


def _fetch_hot_rank(date):
    """Fetch hot stock rankings from Eastmoney."""
    start = time.monotonic()
    try:
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "pn": "1", "pz": "20", "po": "1", "np": "1",
            "fltt": "2", "invt": "2",
            "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
            "fields": "f2,f3,f4,f12,f14,f104,f105,f127",
        }
        r = em_get(url, params=params, timeout=10)
        _http = dict(url=str(r.url)[:200], status_code=r.status_code,
                     response_size=len(r.content), response_snippet=r.text[:2000])
        d = r.json()
        items = d.get("data", {}).get("diff", [])
        result = [
            {"code": item.get("f12"), "name": item.get("f14"),
             "change_pct": item.get("f3", 0), "price": item.get("f2", 0)}
            for item in items[:20]
        ]
        record_call("sentiment/hot_rank", success=True, duration_ms=(time.monotonic() - start) * 1000, **_http)
        return result
    except Exception as e:
        record_call("sentiment/hot_rank", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
        return None


def _fetch_zt_pool(date, code=None):
    """Fetch limit-up pool (涨停板池) as a short-term sentiment thermometer.

    Returns limit-up count, streak (连板) distribution, max streak, top
    industries, and whether the target stock is itself in the pool. Source:
    akshare stock_zt_pool_em (Eastmoney push2ex underneath).

    Non-trading days return an empty pool from akshare; we roll back up to 4
    days to find the most recent trading day. `actual_date` records which
    day's data was used so the LLM knows the data may be stale. Returns None
    on fetch failure or when no trading day is found in the window.
    """
    import datetime as _dt
    from collections import Counter
    start = time.monotonic()
    df = None
    actual = None
    try:
        base = _dt.datetime.strptime(date.replace("-", ""), "%Y%m%d")
    except ValueError:
        record_call("sentiment/zt_pool", success=False, error="Invalid date format", duration_ms=(time.monotonic() - start) * 1000)
        return None

    for offset in range(5):
        candidate = (base - _dt.timedelta(days=offset)).strftime("%Y%m%d")
        try:
            import akshare as ak
            cand_df = ak.stock_zt_pool_em(date=candidate)
        except Exception:
            continue
        if cand_df is not None and len(cand_df) > 0:
            df = cand_df
            actual = candidate
            break

    if df is None:
        record_call("sentiment/zt_pool", success=False, error="No trading day found in 5-day window", duration_ms=(time.monotonic() - start) * 1000)
        return None

    # Column lookup by keyword — naming/order varies across akshare versions.
    def _col(keyword):
        for c in df.columns:
            if keyword in str(c):
                return c
        return None

    streak_col = _col("连板数")
    industry_col = _col("行业")
    code_col = _col("代码")
    name_col = _col("名称")

    # Filter NaN/None streaks (NaN != NaN trick)
    raw_streaks = df[streak_col].tolist() if streak_col else []
    streaks = [int(s) for s in raw_streaks if s is not None and s == s]
    dist = Counter(streaks)
    dist_sorted = dict(sorted(dist.items(), reverse=True))
    # Pre-formatted text — project convention: pre-compute to avoid LLM arithmetic errors
    # (see competitor-analysis §4 "预计算技术指标…避免 LLM 自己算错")
    dist_text = "/".join(f"{k}板{v}家" for k, v in dist_sorted.items())

    top_industries = []
    if industry_col:
        ind_dist = Counter(df[industry_col].tolist())
        top_industries = [{"industry": str(k), "count": int(v)}
                          for k, v in ind_dist.most_common(5)]

    result = {
        "actual_date": f"{actual[:4]}-{actual[4:6]}-{actual[6:]}" if actual else None,
        "limit_up_count": int(len(df)),
        "max_streak": int(max(streaks)) if streaks else 0,
        "streak_distribution": {int(k): int(v) for k, v in dist_sorted.items()},
        "streak_distribution_text": dist_text,
        "top_industries": top_industries,
    }

    # Is the target stock itself in the limit-up pool?
    if code_col and code:
        match = df[df[code_col].astype(str) == str(code)]
        if len(match):
            row = match.iloc[0]
            target = {"streak": int(row[streak_col]) if streak_col else None}
            if name_col:
                target["name"] = str(row[name_col])
            if industry_col:
                target["industry"] = str(row[industry_col])
            result["target_in_pool"] = target

    # Previous trading day's count for continuity context (best-effort)
    try:
        prev = (base - _dt.timedelta(days=1)).strftime("%Y%m%d")
        dfp = ak.stock_zt_pool_em(date=prev)
        if dfp is not None:
            result["previous_day_count"] = int(len(dfp))
    except Exception:
        pass

    record_call("sentiment/zt_pool", success=True, duration_ms=(time.monotonic() - start) * 1000)
    return result


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
        try:
            text = text[text.index("(") + 1: text.rindex(")")]
        except ValueError:
            pass
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


def _fetch_stock_news(code):
    """个股新闻：问财官方 OpenAPI 主源，空/未配/失败 → 东财兜底。

    对齐 news.py 已验证模式（行 685-692）。问财主源返回权威财经媒体 + 真实来源
    + 相关度评分；东财 search-api-web 需 TLS 指纹（cffi_get）但本函数原 em_get
    路径未过指纹、实测返回 0 条（被 JA3 反爬挡掉），现降为兜底。返回
    (articles, source)，source ∈ {"iwencai","eastmoney","none"}。
    """
    iw = get_iwencai_client()
    articles = iw.search_news(code) if code else []
    if articles:
        return articles, "iwencai"
    articles = _fetch_stock_news_eastmoney(code)
    return articles, ("eastmoney" if articles else "none")


def fetch_sentiment(ticker, date):
    """Fetch sentiment indicators with pre-computed sentiment score."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["hot_rank"] = _fetch_hot_rank(date)
    data["zt_pool"] = _fetch_zt_pool(date, code)
    articles, source = _fetch_stock_news(code)
    data["stock_news"] = articles
    data["stock_news_source"] = source
    data["news_count"] = len(articles)

    # Pre-compute sentiment score
    if articles:
        data["news_sentiment"] = _score_sentiment(articles)

    # Check hot rank position
    data["stock_hot_position"] = _check_hot_rank_position(data.get("hot_rank"), code)

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