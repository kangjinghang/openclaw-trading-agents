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
from http_helpers import em_get, http_get, cffi_get, output_json, normalize_ticker, record_call

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# 东方财富新闻 content 末尾常附带关联股票列表（代码+价格+涨跌+成交额），对 LLM 是噪声。
# 策略：找最后一个 ：或 : ，如果其后包含 6 位股票代码，则截断。
_STOCK_CODE_RE = re.compile(r"\d{6}")


def _clean_content(text):
    """去除新闻 content 末尾的关联股票列表噪声。"""
    if not text:
        return text
    last_colon = -1
    for m in re.finditer(r"[：:]", text):
        if _STOCK_CODE_RE.search(text[m.end():]):
            last_colon = m.start()
    if last_colon >= 0:
        cleaned = text[:last_colon].strip()
        return cleaned if cleaned else text
    return text


def _strip_em_tags(text):
    """去除东财搜索结果中的 <em>关键词高亮</em> 标签（akshare stock_news_em 同款清洗）。

    search-api-web 的 cmsArticleWebOld 返回的 title/content 把匹配关键词包在
    <em>...</em> 里做高亮，对 LLM 是噪声。清洗后还原纯文本。
    """
    if not text:
        return text
    return re.sub(r"</?em>", "", text)


def _fetch_news_eastmoney(code, page_size=50):
    """Fetch individual stock news from Eastmoney search API (search-api-web).

    复刻 akshare stock_news_em 的请求逻辑（同 URL / 同 type / 同 param 结构），
    但用 curl_cffi 走 TLS 指纹而非调 akshare 库——这样能走 record_call 采集
    子源级请求/响应详情（URL/status/snippet）进 data-trace.html，且不引入
    akshare 的 DataFrame 转换开销。

    关键：search-api-web 现已启用 TLS 指纹反爬（JA3 检测），普通 requests 被
    识别为爬虫 → 返回降级假数据 passportWeb（股吧用户），真实的文章字段
    cmsArticleWebOld 消失。必须用 curl_cffi impersonate='chrome' 模拟 Chrome
    的 JA3 指纹。akshare 即因此依赖 curl_cffi。
    """
    start = time.monotonic()
    url = "https://search-api-web.eastmoney.com/search/jsonp"
    try:
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
                    "preTag": "<em>",
                    "postTag": "</em>",
                }
            },
        }
        params = {
            "cb": "callback",
            "param": json.dumps(inner_param, ensure_ascii=False),
            "_": str(int(time.time() * 1000)),
        }
        headers = {
            "accept": "*/*",
            "referer": f"https://so.eastmoney.com/news/s?keyword={code}",
            "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/142.0.0.0 Safari/537.36"),
        }
        resp = cffi_get(url, params=params, headers=headers, timeout=15)
        text = resp.text
        # JSONP: extract JSON from callback wrapper; fall back to raw JSON
        try:
            text = text[text.index("(") + 1: text.rindex(")")]
        except ValueError:
            pass  # no parentheses → try raw JSON
        data = json.loads(text)
        raw_articles = data.get("result", {}).get("cmsArticleWebOld", [])
        articles = []
        for item in raw_articles:
            title = _strip_em_tags(item.get("title", "") or "")
            content = _clean_content(_strip_em_tags((item.get("content", "") or "")[:300]))
            articles.append({
                "title": title,
                "content": content,
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
                    duration_ms=(time.monotonic() - start) * 1000, url=url)
        return []


def _rank_news_by_relevance(articles, company_name=None, code="", top_n=20):
    """按相关性分 tier 排序新闻：公司名精确匹配 > 代码出现 > 简称 > 其余.

    同 tier 内按时间倒序（最新优先）。无 company_name 时降级为仅代码匹配。

    Tier 0: title 或 content 包含公司全名（如"海特高新"）
    Tier 1: title 或 content 包含 ticker code（如"002023"）
    Tier 2: title 或 content 包含公司简称（取 company_name 前 2 字，如"海特"）
    Tier 3: 其余（概念/板块相关，保留但排最后）
    """
    if not articles:
        return articles

    # 准备匹配关键词
    name_upper = (company_name or "").strip().upper()
    code_str = str(code).strip()
    # 简称：取公司名前 2 字（仅中文有效，至少 2 字才取）
    short_name = ""
    if company_name and len(company_name) >= 2:
        short_name = company_name[:2]

    def _tier(article):
        """返回该文章的 tier 编号（0=最高，3=最低）."""
        text = (article.get("title", "") + " " + article.get("content", "")).upper()
        # Tier 0: 公司全名精确匹配
        if name_upper and name_upper in text:
            return 0
        # Tier 1: ticker code 出现
        if code_str and code_str in text:
            return 1
        # Tier 2: 公司简称匹配
        if short_name and short_name.upper() in text:
            return 2
        # Tier 3: 概念相关（无精确匹配）
        return 3

    # 分 tier 后同 tier 内按时间倒序（最新优先）
    articles_with_tier = [(a, _tier(a)) for a in articles]
    # 两次稳定排序：先按时间降序（最新优先），再按 tier 升序（0 最高）
    # Python sort 是稳定排序，第二次 sort 保持同 tier 内的时间顺序
    articles_with_tier.sort(key=lambda x: x[0].get("time", ""), reverse=True)
    articles_with_tier.sort(key=lambda x: x[1])
    result = [a for a, _ in articles_with_tier]
    # 不足 5 条时不截断（宁缺毋滥）
    if len(result) <= 5:
        return result
    return result[:top_n]


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
                            status_code=r.status_code, response_snippet=r.text[:2000])
                continue
            bars = json.loads(m.group(1))
            if not bars:
                record_call(f"news/commodity_{symbol}", success=False,
                            error="empty kline", duration_ms=(time.monotonic() - start) * 1000, url=url,
                            status_code=r.status_code, response_size=len(r.content))
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
                        duration_ms=(time.monotonic() - start) * 1000, url=url,
                        status_code=getattr(r, 'status_code', None),
                        response_size=len(r.content) if hasattr(r, 'content') else None)
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


def _filter_recent(articles, reference_date_str, lookback_days):
    """对个股新闻做 lookback 窗口裁剪 + 去重，保证 stock_news 与 news_layers 语义一致。

    背景：_categorize_news 把老新闻挡在 news_layers 之外（分层是干净的），但注释
    明写 "keep in flat list"——老新闻仍留在 stock_news 扁平列表里，而 orchestrator
    和 watchlist data-fetcher 注入 prompt 的正是这个未裁剪的 stock_news，导致跨年
    研报（如 2024 半年报点评）混进 LLM 视野。本函数在 _categorize_news 之后对
    stock_news 做同口径裁剪，根治该问题。

    两步：
      1. lookback 裁剪：复用 _parse_news_time + cutoff_history（与 _categorize_news
         同一参考日 + 同一窗口）。时间解析失败的文章**保留**（宁多勿少——防误杀当天
         突发新闻，东财 date 格式偶有 "MM-DD" 无年份的简写）。
      2. 去重：title（trim 后）完全相同视为重复，保留首条。修 pywencai 同篇研报
         返回多次的问题；东财本身实测无重复，但保留作防御。
    """
    try:
        ref_date = datetime.strptime(reference_date_str, "%Y-%m-%d")
    except (ValueError, TypeError):
        ref_date = datetime.now()
    cutoff = ref_date.replace(hour=23, minute=59, second=59) - timedelta(days=max(1, lookback_days))

    seen_titles = set()
    kept = []
    for article in articles:
        # 去重：归一化 title 后判等。空 title 不参与去重（无可判等标识，
        # 误把多条无标题新闻合并成一条会丢真实信息）。
        title_key = (article.get("title", "") or "").strip()
        if title_key and title_key in seen_titles:
            continue
        # lookback 裁剪：解析失败（None）→ 保留；解析成功但早于 cutoff → 丢弃
        pub_time = _parse_news_time(article.get("time", ""))
        if pub_time is not None and pub_time < cutoff:
            continue
        if title_key:
            seen_titles.add(title_key)
        kept.append(article)
    return kept


def _filter_relevance(articles, company_name, code):
    """过滤纯板块/市场新闻，只保留个股相关新闻。

    背景：东财 search-api-web 的搜索语义是"全文提及股票代码的文章"，返回的
    50 条里约一半是板块新闻（计算机行业资金流、概念涨跌、涨停复盘），股票代码
    只出现在 content 末尾的关联股票列表里——对个股决策无增量，LLM 看到会误判为
    个股信号。本函数在 _noise_re 之后做第二道过滤，挡掉这类纯板块新闻。

    规则（实测验证：50 条 → noise 挡 25 → 本函数再挡 14，留 11 条个股新闻）：
      - 有 company_name：title 或 content **前 80 字**（正文开头，排除末尾关联列表）
        含**完整公司名** → 保留。
        用 content 前 80 字而非全文：东财把关联股票列表拼在 content 末尾，全名
        匹配全文会误放行"末尾列表里恰好含公司全名"的板块新闻。
        不用简称切片（company_name[:2]）——"中科"会误匹配中科信息等同源公司。
      - 无 company_name（降级）：代码必须出现在 **title**（而非仅 content）→ 保留。
        分析师 pipeline 的 news 角色不传 --company-name，走此降级路径。
      - 其余丢弃（纯板块新闻：代码只在 content 末尾关联列表）。

    附带保留：content 提及公司名的汇总文（中证快报、大盘蓝筹）会通过——它们至少
    相关且数量少，危害远小于挡掉真个股新闻的代价。
    """
    name = (company_name or "").strip()
    code_str = str(code or "").strip()
    kept = []
    for article in articles:
        title = article.get("title", "") or ""
        content = article.get("content", "") or ""
        body_start = content[:80]  # 正文开头，排除末尾关联股票列表
        if name and (name in title or name in body_start):
            kept.append(article)
        elif code_str and code_str in title:
            kept.append(article)
        # else: 纯板块新闻（代码只在 content 末尾关联列表）→ 丢弃
    return kept


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


def fetch_news(ticker, date, lookback_days=7, skip_macro=False, company_name=None):
    """Fetch individual stock news + macro news with time-layered categorization.

    skip_macro=True 时跳过宏观新闻拉取（CLS + akshare 两路 HTTP 全省）。
    适用于 shallow-analyzer 这类快筛场景：候选池 N 股各自调用 news.py，
    宏观新闻与 ticker 无关、N 次拉取内容相同纯属浪费，且 shallow 不消费宏观。
    跳过后 macro_news 仍输出空数组 + macro_news_source="skipped"，保持结构稳定。

    company_name 用于新闻相关性排序：公司名精确匹配 > 代码 > 简称 > 概念相关。
    缺失时降级为仅代码匹配。排序后取 top 20 条注入 LLM prompt。
    """
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date, "lookback_days": lookback_days}

    try:
        # 东财 search-api-web 为唯一源（复刻 akshare stock_news_em 请求逻辑，
        # 走 curl_cffi TLS 指纹）。返回按时间倒序的最新新闻（实测当天有效），
        # 无 pywencai 那种 2024 老研报/重复条目问题。
        # 历史上曾用 pywencai 作主源，但实测问财返回公司关联文档（含跨年研报 +
        # 同篇重复），信噪比差；已移除，东财为唯一源。
        articles = _fetch_news_eastmoney(code)

        # 过滤榜单类噪音：资金流向榜、概念涨跌、特大单统计等。
        # 这些是市场面/板块面信号，对个股决策无增量，LLM 看到可能误判为个股信号。
        _noise_re = re.compile(
            r"(净流入|净流出|主力资金|特大单|出逃|融资客|概念涨|概念跌|"
            r"概念上涨|概念下跌|资金撤离|资金流入|榜单|资金流向)")
        articles = [a for a in articles if not _noise_re.search(a["title"])]

        # 相关性过滤：挡掉纯板块新闻（代码只在 content 末尾关联列表），
        # 只保留个股相关新闻（title 或正文开头含公司名/代码）。
        articles = _filter_relevance(articles, company_name, code)

        # lookback 裁剪 + 去重：防御任何源的老数据/重复混入（与 news_layers
        # 的 cutoff_history 同口径，保证 stock_news 扁平列表与分层语义一致）。
        articles = _filter_recent(articles, date, lookback_days)

        # 相关性排序：公司名 > 代码 > 简称 > 概念相关（同 tier 内按时间倒序）
        articles = _rank_news_by_relevance(articles, company_name=company_name, code=code)
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
    # --macro-only 时不需要 ticker（全市场宏观信号），故 ticker/date 设为非必需，
    # 在非 macro-only 分支手动校验，保持原有 required 语义。
    parser.add_argument("--ticker", required=False, default=None, help="Stock ticker code")
    parser.add_argument("--date", required=False, default=None, help="Analysis date YYYY-MM-DD")
    parser.add_argument("--lookback-days", type=int, default=7, help="Days to look back")
    parser.add_argument("--skip-macro", action="store_true",
                        help="Skip macro news fetch (CLS+akshare). For shallow-analyzer "
                             "batch scenarios where macro is unused and per-ticker duplicate.")
    parser.add_argument("--company-name", required=False, default=None,
                        help="Company name (e.g. 海特高新) for news relevance ranking. "
                             "Articles mentioning the company name are ranked higher.")
    parser.add_argument("--macro-only", action="store_true",
                        help="Only fetch macro data (NBS indicators + commodities + "
                             "sector_view), skip per-stock news. For rebalancer pipeline "
                             "where macro is a one-time market-wide fetch injected into the "
                             "portfolio-decision layer (avoids N redundant per-ticker calls).")
    args = parser.parse_args()

    # ── --macro-only 分支：全市场宏观，一次性抓取 ──
    # 用于 watchlist rebalancer 第 5 层（组合决策），宏观与具体股票无关，抓 1 次即可。
    # 复用 _fetch_macro_nbs / _fetch_commodities / _build_macro_sector_view，零重复逻辑。
    # 失败 graceful degrade（对应字段不输出），不抛异常。
    if args.macro_only:
        date = args.date or datetime.now().strftime("%Y-%m-%d")
        data = {"ticker": "MACRO", "date": date}
        try:
            indicators = _fetch_macro_nbs()
            if indicators:
                data["macro_indicators"] = indicators
                data["sector_view"] = _build_macro_sector_view(indicators)
        except Exception as e:
            data["macro_indicators_error"] = str(e)
        try:
            commodities = _fetch_commodities()
            if commodities:
                data["commodities"] = commodities
        except Exception as e:
            data["commodities_error"] = str(e)
        output_json(True, data=data, source="macro-only")
        return

    # ── 常规分支：个股新闻 + （可选）宏观 ──
    if not args.ticker or not args.date:
        parser.error("--ticker and --date are required unless --macro-only is set")

    try:
        data = fetch_news(args.ticker, args.date, args.lookback_days,
                          skip_macro=args.skip_macro, company_name=args.company_name)
        # Reflect the macro source actually used (cls/akshare/skipped/none) in the
        # top-level _source so it's visible without drilling into data.
        macro_src = data.get("macro_news_source", "none")
        output_json(True, data=data, source=f"eastmoney+{macro_src}")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()