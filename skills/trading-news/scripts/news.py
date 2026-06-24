#!/usr/bin/env python3
"""Fetch stock news (individual + macro/global) for A-share stocks with time-layered categorization."""

import argparse
import json
import re
import sys
import os
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import em_get, http_get, output_json, normalize_ticker, record_call, pywencai_query

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
        # JSONP: extract JSON from callback wrapper; fall back to raw JSON
        try:
            text = text[text.index("(") + 1: text.rindex(")")]
        except ValueError:
            pass  # no parentheses → try raw JSON
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


def _fetch_news_pywencai(code, limit=20):
    """Supplement stock news from pywencai (同花顺问财) when eastmoney is thin.

    Returns [] when pywencai is unavailable or returns nothing — callers treat
    a non-None empty list the same as "no supplement", and None (pywencai not
    installed) is guarded by the caller. pywencai columns are 中文 and vary, so
    we try several common title/content/time aliases.
    """
    rows = pywencai_query(f"{code}新闻")
    if not rows:
        return []
    articles = []
    for row in rows[:limit]:
        title = str(row.get("新闻标题") or row.get("标题") or "")
        content = str(row.get("新闻内容") or row.get("内容") or "")[:300]
        pub_time = str(row.get("发布时间") or row.get("日期") or "")
        if title:
            articles.append({"title": title, "content": content,
                             "time": pub_time[:16], "source": "问财"})
    return articles


def _fetch_announcements_pywencai(code, limit=10):
    """Fetch company announcements via pywencai natural language query."""
    rows = pywencai_query(f"{code}公告")
    if not rows:
        return []
    items = []
    for row in rows[:limit]:
        title = str(row.get("公告标题") or row.get("标题") or "")
        content = str(row.get("公告内容") or row.get("内容") or "")[:300]
        pub_time = str(row.get("发布时间") or row.get("日期") or "")
        if title:
            items.append({"title": title, "content": content,
                          "time": pub_time[:16], "source": "问财公告"})
    return items


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


# ── NBS macro indicators via akshare ────────────────────────────────
# Fetches 7 macro indicators via akshare. M2 and LPR have non-standard
# column shapes and are handled separately. Returns
# {indicator_key: {"latest": float, "label": str}}.

_NBS_INDICATORS = {
    # key: (akshare_fn, value-extractor, label)
    # 全部走金十数据中心 datacenter-api.jin10.com（同一源），列名统一为"今值"。
    "gdp_yoy": ("macro_china_gdp_yearly", "今值", "GDP当季同比"),
    "cpi_yoy": ("macro_china_cpi_monthly", "今值", "CPI同比"),
    "ppi_yoy": ("macro_china_ppi_yearly", "今值", "PPI同比"),
    "manufacturing_pmi": ("macro_china_pmi_yearly", "今值", "制造业PMI"),
    # 财新制造业 PMI：与官方 PMI 形成双口径——官方 PMI 偏大国企样本、
    # 财新 PMI 偏中小企业样本，两者背离（如官方>50 而财新<50）是重要结构信号，
    # 指示景气分化。同走金十源（attr_id=73），列名同为"今值"。
    "caixin_pmi": ("macro_china_cx_pmi_yearly", "今值", "财新制造业PMI"),
    "non_manufacturing_pmi": ("macro_china_non_man_pmi", "今值", "非制造业PMI"),
}


def _fetch_macro_nbs():
    """Fetch core NBS macro indicators via akshare.

    Returns a dict {key: {"latest": float, "label": str}} for whichever
    indicators akshare successfully returned (partial result on partial
    failure — never raises). Includes M2 separately since its column shape
    differs. Returns {} if akshare is unavailable.
    """
    start = time.monotonic()
    try:
        import akshare as ak
    except ImportError:
        record_call("news/macro_nbs", success=False, error="akshare not installed",
                    duration_ms=(time.monotonic() - start) * 1000)
        return {}

    result = {}
    for key, (fn_name, col, label) in _NBS_INDICATORS.items():
        fn = getattr(ak, fn_name, None)
        if fn is None:
            continue
        try:
            df = fn()
            if df is None or len(df) == 0 or col not in df.columns:
                continue
            val = df[col].iloc[-1]
            val = float(val) if val is not None and str(val) != "nan" else None
            if val is not None:
                result[key] = {"latest": val, "label": label}
        except Exception:
            continue

    # M2 同比 has a different column shape (货币和准货币(M2)-同比增长)
    try:
        df = ak.macro_china_money_supply()
        if df is not None and len(df) > 0:
            m2_col = next((c for c in df.columns if "M2" in c and "同比" in c), None)
            if m2_col:
                val = df[m2_col].iloc[-1]
                val = float(val) if val is not None and str(val) != "nan" else None
                if val is not None:
                    result["m2_yoy"] = {"latest": val, "label": "M2同比"}
    except Exception:
        pass

    # LPR (Loan Prime Rate) — column shape differs (TRADE_DATE/LPR1Y/LPR5Y/...)
    try:
        df = ak.macro_china_lpr()
        if df is not None and len(df) > 0:
            lpr1y = df["LPR1Y"].iloc[-1]
            lpr5y = df["LPR5Y"].iloc[-1]
            lpr1y = float(lpr1y) if lpr1y is not None and str(lpr1y) != "nan" else None
            lpr5y = float(lpr5y) if lpr5y is not None and str(lpr5y) != "nan" else None
            if lpr1y is not None:
                result["lpr_1y"] = {"latest": lpr1y, "label": "1年期LPR"}
            if lpr5y is not None:
                result["lpr_5y"] = {"latest": lpr5y, "label": "5年期LPR"}
    except Exception:
        pass

    record_call("news/macro_nbs", success=bool(result),
                error=None if result else "all macro indicators unavailable",
                duration_ms=(time.monotonic() - start) * 1000)
    return result


# ── 大宗商品（国际周期定价锚）─────────────────────────────────────────
# 新浪期货主力连续日K（金AU0/油SC0/铜CU0），补齐 openclaw 宏观缺的国际周期视角。
# 这三个品种是美林时钟/康波周期分析的核心定价锚：黄金（避险/实际利率）、
# 原油（通胀/需求）、铜（全球工业需求"铜博士"）。source: aiagents-stock
# macro_cycle_data 的 futures_main_sina 同接口。新浪响应开头有反爬注释
# /*<script>...</script>*/，需正则取 ([...]) 内的 JSON。

_COMMODITIES = {
    # akshare symbol: 中文 label
    "AU0": "黄金",
    "SC0": "原油",
    "CU0": "铜",
}


def _price_change_pct(closes, n):
    """近 n 日涨跌幅 %（预计算，禁止 LLM 重算）。closes 按时间升序（旧→新）。
    不足 n+1 根返回 None。"""
    if len(closes) < n + 1:
        return None
    return round((closes[-1] / closes[-1 - n] - 1) * 100, 2)


def _fetch_commodities():
    """Fetch gold/oil/copper main-continuous futures (新浪) for cycle analysis.

    Returns {symbol: {label, latest_price, chg_5d, chg_20d, trend, as_of}}.
    Each symbol independent try/except — one failure doesn't block others.
    Returns {} if all fail (caller graceful-degrades).
    """
    result = {}
    for symbol, label in _COMMODITIES.items():
        start = time.monotonic()
        url = (f"https://stock2.finance.sina.com.cn/futures/api/jsonp.php"
               f"/var%20_{symbol}2021_08_17=/InnerFuturesNewService.getDailyKLine"
               f"?symbol={symbol}&_=2021_08_17")
        try:
            r = http_get(url, timeout=15, headers={"User-Agent": _UA})
            m = re.search(r"=\((\[.*\])\)", r.text, re.S)
            if not m:
                record_call(f"news/commodity_{symbol}", success=False,
                            error="jsonp parse failed",
                            duration_ms=(time.monotonic() - start) * 1000, url=url,
                            status_code=r.status_code, response_snippet=r.text[:200])
                continue
            bars = json.loads(m.group(1))
            if not bars:
                record_call(f"news/commodity_{symbol}", success=False,
                            error="empty kline", duration_ms=(time.monotonic() - start) * 1000, url=url)
                continue
            closes = [float(b["c"]) for b in bars if b.get("c")]
            chg_5d = _price_change_pct(closes, 5)
            chg_20d = _price_change_pct(closes, 20)
            # 趋势标签：5日与20日同向 → 趋势确立，背离 → 震荡/拐点
            if chg_5d is not None and chg_20d is not None:
                if chg_5d > 0 and chg_20d > 0:
                    trend = "上行"
                elif chg_5d < 0 and chg_20d < 0:
                    trend = "下行"
                else:
                    trend = "震荡/拐点"
            else:
                trend = None
            result[symbol] = {
                "label": label,
                "latest_price": closes[-1] if closes else None,
                "as_of": bars[-1].get("d", ""),
                "chg_5d": chg_5d,
                "chg_20d": chg_20d,
                "trend": trend,
            }
            record_call(f"news/commodity_{symbol}", success=True,
                        duration_ms=(time.monotonic() - start) * 1000, url=url,
                        status_code=r.status_code, response_size=len(r.content))
        except Exception as e:
            record_call(f"news/commodity_{symbol}", success=False, error=str(e),
                        duration_ms=(time.monotonic() - start) * 1000, url=url)
    return result


# ── Rule-based macro → sector mapping engine ────────────────────────
# Borrowed from aiagents-stock's build_rule_based_sector_view, adapted to our
# {key: {"latest": val}} indicator shape (aiagents-stock uses {"value"}). Maps
# the indicators the engine cares about to 15 sector scores, then derives
# market_view + bullish/bearish sectors. Pure function, network-free.

_SECTOR_RULES = {
    # sector: list of (indicator_key, threshold, score_delta, reason [, direction])
    # direction defaults to "above" (val >= threshold); use "below" for lower-is-better
    "银行": [("m2_yoy", 7, 2, "流动性保持充裕"), ("cpi_yoy", 1, 1, "通胀温和为估值修复留出空间", "below"),
             ("lpr_1y", 3.5, 1, "利率偏低利好信贷扩张", "below")],
    "券商": [("m2_yoy", 7, 2, "流动性保持充裕"), ("lpr_1y", 3.5, 1, "低利率环境利好市场交投", "below")],
    "保险": [("m2_yoy", 7, 2, "流动性保持充裕"), ("lpr_5y", 4.0, 1, "长端利率偏低提升债券投资价值", "below")],
    "公用事业": [("m2_yoy", 7, 2, "流动性保持充裕"), ("cpi_yoy", 1, 1, "通胀温和")],
    "食品饮料": [("cpi_yoy", 1, 1, "通胀温和")],
    "家电": [("cpi_yoy", 1, 1, "通胀温和")],
    "工程机械": [("manufacturing_pmi", 50, 2, "制造业景气改善"),
              ("manufacturing_pmi", None, -1, "制造业景气仍在荣枯线下"),
              ("caixin_pmi", 50, 1, "财新PMI确认中小企业景气改善")],
    "有色金属": [("manufacturing_pmi", 50, 2, "制造业景气改善"),
               ("caixin_pmi", 50, 1, "财新PMI确认景气改善"),
               ("ppi_yoy", None, -1, "工业品价格承压")],
    "半导体": [("manufacturing_pmi", 50, 2, "制造业景气改善"),
              ("manufacturing_pmi", None, -1, "制造业景气仍在荣枯线下"),
              ("caixin_pmi", 50, 1, "财新PMI确认景气改善")],
    "算力AI": [("manufacturing_pmi", 50, 2, "制造业景气改善"),
              ("caixin_pmi", 50, 1, "财新PMI确认景气改善")],
    "软件信创": [("manufacturing_pmi", 50, 2, "制造业景气改善"),
               ("caixin_pmi", 50, 1, "财新PMI确认景气改善")],
    "房地产": [("lpr_5y", 4.0, 2, "房贷利率偏低利好购房需求", "below")],
    "煤炭": [("ppi_yoy", None, -1, "工业品价格承压")],
    "石油石化": [("ppi_yoy", None, -1, "工业品价格承压")],
}


def _apply_sector_rule(val, threshold, delta, direction="above"):
    """Return (applied: bool, score: int). threshold=None means unconditional
    apply when val is not None. direction='above' → val >= threshold triggers;
    direction='below' → val <= threshold triggers."""
    if val is None:
        return False, 0
    if threshold is None:
        return True, delta
    if direction == "below" and val <= threshold:
        return True, delta
    if direction == "above" and val >= threshold:
        return True, delta
    if delta < 0 and val < threshold:
        return True, delta
    return False, 0


def _build_macro_sector_view(indicators):
    """Map macro indicators to a sector rotation view (pure rule engine).

    Args:
        indicators: {key: {"latest": float}} — NBS indicator values. Missing
            keys are skipped (partial input → partial view).

    Returns: {total_score, market_view, bullish_sectors, bearish_sectors,
              indicators_used, sector_scores}.
    """
    indicators_used = sorted(k for k, v in indicators.items() if v.get("latest") is not None)

    sector_scores = {}
    sector_reasons = {}
    for sector, rules in _SECTOR_RULES.items():
        score = 0
        reasons = []
        for rule in rules:
            ind_key, threshold, delta, reason = rule[0], rule[1], rule[2], rule[3]
            direction = rule[4] if len(rule) > 4 else "above"
            val = indicators.get(ind_key, {}).get("latest")
            applied, s = _apply_sector_rule(val, threshold, delta, direction)
            if applied:
                score += s
                reasons.append(reason)
        sector_scores[sector] = score
        sector_reasons[sector] = reasons

    total_score = sum(sector_scores.values())

    bullish = sorted(
        ({"sector": s, "score": sc} for s, sc in sector_scores.items() if sc > 0),
        key=lambda x: x["score"], reverse=True,
    )
    bearish = sorted(
        ({"sector": s, "score": sc} for s, sc in sector_scores.items() if sc < 0),
        key=lambda x: x["score"],
    )

    # Market view: derived from the macro tilt
    growth_signals = 0
    mfg = indicators.get("manufacturing_pmi", {}).get("latest")
    cx = indicators.get("caixin_pmi", {}).get("latest")
    gdp = indicators.get("gdp_yoy", {}).get("latest")
    lpr1y = indicators.get("lpr_1y", {}).get("latest")
    if gdp is not None and gdp >= 4.5:
        growth_signals += 1
    if mfg is not None and mfg >= 50:
        growth_signals += 1
    if lpr1y is not None and lpr1y < 3.5:
        growth_signals += 1

    # 财新PMI 双口径共振/背离：官方与财新同时 ≥50 → 共振向上；同时 <50 →
    # 共振向下；一上一下 → 景气分化（结构信号，倾向"结构性机会"而非单边）。
    pmi_signal = None
    if mfg is not None and cx is not None:
        if mfg >= 50 and cx >= 50:
            pmi_signal = "官方与财新PMI双口径共振向上"
            growth_signals += 1
        elif mfg < 50 and cx < 50:
            pmi_signal = "官方与财新PMI双口径共振向下"
            growth_signals -= 1
        else:
            pmi_signal = f"PMI双口径分化（官方{mfg}/财新{cx}，景气结构性分裂）"

    if growth_signals >= 2:
        market_view = "震荡偏多"
    elif growth_signals <= -1:
        market_view = "震荡偏谨慎"
    else:
        market_view = "结构性机会为主"

    view = {
        "total_score": total_score,
        "market_view": market_view,
        "bullish_sectors": [b["sector"] for b in bullish],
        "bearish_sectors": [b["sector"] for b in bearish],
        "indicators_used": indicators_used,
        "sector_scores": dict(sorted(sector_scores.items(), key=lambda x: x[1], reverse=True)[:10]),
    }
    if pmi_signal:
        view["pmi_signal"] = pmi_signal
    return view


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
        # pywencai 补充：东财新闻偏少（<10 篇）时用问财自然语言查询补个股新闻，
        # 避免新闻面数据稀疏导致分析师无料可议。pywencai 未装/查询失败 → 不阻塞。
        if len(articles) < 10:
            try:
                articles = articles + _fetch_news_pywencai(code)
            except Exception as e:
                data["stock_news_pywencai_error"] = str(e)
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

    # NBS 宏观指标 + 大宗商品 + 板块映射：仅在 lookback_days >= 14 时触发（policy 角色用 14/30，
    # 默认 news 角色用 7 不触发）。宏观是政策/周期判断的骨架，但对短线新闻面是噪音，
    # 故按窗口门控。拉取失败 graceful degrade（不输出对应字段）。
    if lookback_days >= 14:
        try:
            indicators = _fetch_macro_nbs()
            if indicators:
                data["macro_indicators"] = indicators
                data["sector_view"] = _build_macro_sector_view(indicators)
        except Exception as e:
            data["macro_indicators_error"] = str(e)

        # 大宗商品（金/油/铜）：国际周期定价锚，与国内宏观指标互补。
        try:
            commodities = _fetch_commodities()
            if commodities:
                data["commodities"] = commodities
        except Exception as e:
            data["commodities_error"] = str(e)

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