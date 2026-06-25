#!/usr/bin/env python3
"""Fetch fundamental data for A-share stocks (PE/PB/financials/EPS forecast)."""

import argparse
import json
import math
import sys
import os

# Add parent skills dir to path for shared imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import tencent_quote, em_get, output_json, normalize_ticker, record_error, record_call, pywencai_query
import time
from datetime import datetime


# ── 同花顺问财 8 项能力评分 ──────────────────────────────────────────
# Borrowed from aiagents-stock main_force_selector.py — these are 同花顺 iFinD
# exclusive scores that akshare/tushare don't expose. 8 dimensions cover the
# full fundamental quality picture (盈利/成长/营运/偿债/现金流/资产质量/流动性/
# 资本充足性). Query is single-stock oriented (aiagents-stock batches 100 stocks;
# we analyze one). pywencai is an optional dependency → graceful degrade.

# 中文列名 → 结构化 key 映射（问财返回的列名带"评分"后缀，且可能带日期戳）
_CAPABILITY_FIELDS = {
    "盈利能力": "profitability",
    "成长能力": "growth",
    "营运能力": "operation",
    "偿债能力": "solvency",
    "现金流": "cash_flow",
    "资产质量": "asset_quality",
    "流动性": "liquidity",
    "资本充足性": "capital_adequacy",
}


def _fetch_capability_scores(code):
    """Fetch 8-dimension capability scores from 同花顺问财 (pywencai).

    Returns a dict {english_key: {"score": float|str, "label": 中文}} on success,
    None when pywencai is unavailable / query fails / returns nothing. Scores
    are 同花顺 0-100 ratings; non-numeric values are kept as-is (问财 sometimes
    returns letter grades for uncovered stocks).
    """
    rows = pywencai_query(
        f"{code} 盈利能力评分，成长能力评分，营运能力评分，偿债能力评分，"
        f"现金流评分，资产质量评分，流动性评分，资本充足性评分"
    )
    if not rows:
        return None

    row = rows[0]
    result = {}
    for cn_prefix, en_key in _CAPABILITY_FIELDS.items():
        # 问财列名形如 "盈利能力评分" 或 "盈利能力评分[20241231]"，前缀匹配
        matched_col = next((col for col in row if cn_prefix in str(col)), None)
        if matched_col is not None:
            val = row[matched_col]
            # 尝试转 float（多数是数值评分），失败则保留原值（字母评级/空）
            try:
                val = float(val)
            except (TypeError, ValueError):
                val = str(val) if val is not None and str(val) != "nan" else None
            if val is not None:
                result[en_key] = {"score": val, "label": cn_prefix}

    return result if result else None


def fetch_fundamentals(ticker, date):
    """Fetch fundamentals from Tencent (valuation) + mootdx (financials) + Eastmoney (EPS)."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    # 1. Tencent: real-time valuation
    start = time.monotonic()
    try:
        tq, http = tencent_quote([code])
        if code in tq:
            q = tq[code]
            data["valuation"] = {
                "name": q["name"],
                "price": q["price"],
                "pe_ttm": q["pe_ttm"],
                "pe_static": q["pe_static"],
                "pb": q["pb"],
                "market_cap_yi": q["mcap_yi"],
                "float_market_cap_yi": q["float_mcap_yi"],
                "turnover_pct": q["turnover_pct"],
                "change_pct": q["change_pct"],
            }
        record_call("fundamentals/tencent", success=True,
                    duration_ms=(time.monotonic() - start) * 1000,
                    **http)
    except Exception as e:
        record_call("fundamentals/tencent", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000,
                    url=f"https://qt.gtimg.cn/q={code}")
        data["valuation_error"] = str(e)

    # 2. mootdx: quarterly financial snapshot (expanded fields)
    start = time.monotonic()
    try:
        from mootdx.quotes import Quotes
        market = 1 if code.startswith("6") else 0
        client = Quotes.factory(market=market, timeout=10)
        fin = client.finance(symbol=code)
        if fin is not None and not (hasattr(fin, 'empty') and fin.empty):
            row = fin.iloc[0] if hasattr(fin, 'iloc') else fin
            field_map = {
                "liutongguben": "float_shares",
                "zongguben": "total_shares",
                "jingzichan": "net_assets",
                "zhuyingshouru": "revenue",
                "jinglirun": "net_profit",
                "meigujingzichan": "bvps",
                "weifenpeilirun": "undistributed_profit",
                "zongzichan": "total_assets",
                "gudongrenshu": "shareholder_count",
                "jingyingxianjinliu": "operating_cash_flow",
                # 注意：mootdx 实时 TDX 协议（tdxpy get_finance_info）固定 32 字段，
                # 不含 zichanfuzhailv/xishoumaoliv（资产负债率/毛利率）——这俩只在
                # mootdx Affair 历史财报 zip（columns.py:212/204）里。老实现映射它们
                # 导致 debt_ratio/gross_margin 恒空（tdxpy 源码实证）。
                # 等价数据已在其他子源：资产负债率见 financial_health.debt_ratio_pct，
                # 毛利率见 quarterly_trends.gross_margin（东财 datacenter，真实可用）。
            }
            snapshot = {}
            for py_name, en_name in field_map.items():
                if hasattr(row, 'index') and py_name in row.index:
                    val = row[py_name]
                    if val is not None and str(val) != "nan":
                        snapshot[en_name] = float(val) if not isinstance(val, str) else val

            # Compute ROE if we have net_profit and net_assets
            if snapshot.get("net_profit") and snapshot.get("net_assets"):
                try:
                    snapshot["roe"] = round(snapshot["net_profit"] / snapshot["net_assets"] * 100, 2)
                except (ZeroDivisionError, TypeError):
                    pass

        if snapshot:
            data["financial_snapshot"] = snapshot
        record_call("fundamentals/mootdx", success=True,
                    duration_ms=(time.monotonic() - start) * 1000,
                    url="mootdx://tdx/finance", response_size=len(str(snapshot)))
    except Exception as e:
        record_call("fundamentals/mootdx", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000,
                    url="mootdx://tdx/finance")
        data["financial_snapshot_error"] = str(e)

    # 3. Eastmoney Datacenter: basic stock info (industry, company name)
    #    唯一来源。老实现用 push2（push2.eastmoney.com）作主路 + datacenter 兜底，
    #    但 push2 有严格 per-IP 限流，实测 RemoteDisconnected 频发（_source-health.json
    #    实证：唯一一次运行就失败，白耗 2.5s）。datacenter-web.eastmoney.com 不受限流，
    #    直接独占。TS 下游（parseFundamentals + orchestrator）只消费 industry/name，
    #    datacenter 的 BOARD_NAME/SECURITY_NAME_ABBR 已覆盖。
    info = {}
    start = time.monotonic()
    try:
        url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
        params = {
            "reportName": "RPT_LICO_FN_CPD",
            "columns": "SECURITY_NAME_ABBR,BOARD_NAME,TRADE_MARKET",
            "filter": f'(SECURITY_CODE="{code}")',
            "pageSize": "1",
        }
        r = em_get(url, params=params, timeout=10)
        result = r.json().get("result") or {}
        items = result.get("data") or []
        if items:
            item = items[0]
            if item.get("BOARD_NAME"):
                info["industry"] = item["BOARD_NAME"]
            if item.get("SECURITY_NAME_ABBR"):
                info["name"] = item["SECURITY_NAME_ABBR"]
            # 只有真正拿到数据才算成功；空 items 视为失败，避免"HTTP 200 但业务空"
            # 被 _source-health 误统计为健康（曾导致 industry 全空但健康检查全绿）
            record_call("fundamentals/em_datacenter", success=True,
                        duration_ms=(time.monotonic() - start) * 1000,
                        url=url, status_code=r.status_code, response_size=len(r.content),
                        response_snippet=r.text)
        else:
            record_call("fundamentals/em_datacenter", success=False,
                        error="datacenter returned empty data for ticker",
                        duration_ms=(time.monotonic() - start) * 1000,
                        url=url, status_code=r.status_code)
    except Exception as e:
        record_call("fundamentals/em_datacenter", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000,
                    url=url)
        data["stock_info_error"] = str(e)

    if info:
        data["stock_info"] = info
    elif "stock_info_error" not in data:
        data["stock_info_error"] = "datacenter returned no data"

    # 4. Eastmoney Datacenter: quarterly financial trends (last 4 quarters)
    start = time.monotonic()
    try:
        data["quarterly_trends"], http = _fetch_quarterly_financials(code)
        record_call("fundamentals/em_quarterly", success=True,
                    duration_ms=(time.monotonic() - start) * 1000,
                    **http)
    except Exception as e:
        record_call("fundamentals/em_quarterly", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        data["quarterly_trends_error"] = str(e)

    # 5. Eastmoney: consensus EPS / target price / ratings
    start = time.monotonic()
    try:
        data["consensus_eps"], http = _fetch_consensus_eps(code)
        record_call("fundamentals/em_consensus", success=True,
                    duration_ms=(time.monotonic() - start) * 1000,
                    **http)
    except Exception as e:
        record_call("fundamentals/em_consensus", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        data["consensus_eps_error"] = str(e)

    # 6. Derived forward-valuation metrics (need both valuation + consensus).
    #    Pre-computed to avoid LLM arithmetic errors (project convention;
    #    see competitor-analysis §4 "预计算技术指标…避免 LLM 自己算错").
    consensus = data.get("consensus_eps")
    valuation = data.get("valuation") or {}
    if consensus:
        price = valuation.get("price")
        eps_next = consensus.get("consensus_eps_next")
        if price and eps_next and eps_next > 0:
            consensus["forward_pe"] = round(price / eps_next, 2)
        pe_ttm = valuation.get("pe_ttm")
        growth = consensus.get("eps_growth_pct")
        # PEG is only meaningful for positive earnings growth.
        if pe_ttm and growth and growth > 0:
            consensus["peg"] = round(pe_ttm / growth, 2)

    # 7. Three-statement derived financial-health ratios (akshare sina).
    #    Fills gaps the snapshot/quarterly don't cover: 商誉占比 (goodwill
    #    exposure), OCF/归母净利 (earnings quality), leverage & liquidity
    #    trend, capex/FCF. Pre-computed and lean (~4 periods × ~10 numbers)
    #    rather than dumping raw statements — avoids LLM arithmetic errors
    #    and saves context vs TradingAgents' raw-table approach.
    start = time.monotonic()
    try:
        health = _fetch_financial_health(code)
        # success 标准是"拿到了数据"，不是"没抛异常"。
        # _fetch_financial_health 在 akshare 缺失/拉取失败/无重叠报告期时返回 None，
        # 老实现误报 success=True 掩盖了这些情况（_source-health.json 实证：
        # akshare_internal 失败但外壳 akshare success=True）。
        data["financial_health"] = health
        record_call("fundamentals/akshare", success=health is not None,
                    error=None if health else "no overlapping report periods or akshare unavailable",
                    duration_ms=(time.monotonic() - start) * 1000)
    except Exception as e:
        record_call("fundamentals/akshare", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        data["financial_health_error"] = str(e)

    # 8. PE/PB historical percentile (baidu valuation, akshare).
    #    当前 PE 在近 5 年序列的分位（0-100），治"PE=18 在化工合理/白酒偏低"的判断盲区——
    #    LLM 之前只看到 PE 绝对值无法判断贵贱。近 5 年裁剪避免远古失真（行业转型）。
    start = time.monotonic()
    try:
        pct = _fetch_valuation_percentile(code)
        data["valuation_percentile"] = pct
        record_call("fundamentals/baidu_valuation", success=pct is not None,
                    error=None if pct else "baidu valuation unavailable or series too short",
                    duration_ms=(time.monotonic() - start) * 1000)
    except Exception as e:
        record_call("fundamentals/baidu_valuation", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        data["valuation_percentile_error"] = str(e)

    # 9. Market sentiment extra: ARBR(26日) + turnover interpretation + fear/greed.
    #    Cross-validates market temperature alongside valuation. Sourced from
    #    akshare (already imported for financials). Computed here (not in sentiment.py)
    #    so fundamentals analyst can reference it for a more complete picture.
    start = time.monotonic()
    try:
        mse = _fetch_market_sentiment_extra(code, date)
        data["market_sentiment_extra"] = mse
        record_call("fundamentals/market_sentiment", success=mse is not None,
                    error=None if mse else "market sentiment unavailable",
                    duration_ms=(time.monotonic() - start) * 1000)
    except Exception as e:
        record_call("fundamentals/market_sentiment", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        data["market_sentiment_extra_error"] = str(e)

    # 10. 同花顺问财 8 项能力评分（盈利/成长/营运/偿债/现金流/资产质量/流动性/资本充足性）。
    #    同花顺 iFinD 独家评分，akshare/tushare 均不提供，补基本面"综合质地"盲区——
    #    与前 9 块的绝对财务指标互补（8 项评分是相对同业百分位）。pywencai 是可选依赖，
    #    未装/查询失败 graceful degrade（不阻塞其他 9 块）。
    start = time.monotonic()
    try:
        cap = _fetch_capability_scores(code)
        data["capability_scores"] = cap
        record_call("fundamentals/pywencai_capability", success=cap is not None,
                    error=None if cap else "pywencai unavailable or no scores",
                    duration_ms=(time.monotonic() - start) * 1000)
    except Exception as e:
        record_call("fundamentals/pywencai_capability", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        data["capability_scores_error"] = str(e)

    return data


def _fetch_quarterly_financials(code):
    """Fetch last 4 quarters of revenue/net profit/EPS/YoY from Eastmoney Datacenter.

    Source: Eastmoney Datacenter report RPT_LICO_FN_CPD.

    Note: the report's date column is REPORTDATE (no underscore); an earlier
    sortColumns=REPORT_DATE silently failed every request with success=False
    (same bug class as _fetch_consensus_eps). Result may be null when the
    stock has no quarterly coverage.
    """
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_LICO_FN_CPD",
        "columns": "ALL",
        "filter": f'(SECURITY_CODE="{code}")',
        "pageNumber": "1",
        "pageSize": "5",
        "sortColumns": "REPORTDATE",
        "sortTypes": "-1",
        "source": "WEB",
        "client": "WEB",
    }
    r = em_get(url, params=params, timeout=15)
    http = {"url": url, "status_code": r.status_code,
            "response_size": len(r.content), "response_snippet": r.text[:200]}
    d = r.json()

    results = []
    # Defensive: Eastmoney returns "result": null both on failure and when the
    # stock has no quarterly data. Treat both as "no data".
    items = (d.get("result") or {}).get("data", [])
    for item in (items or [])[:4]:
        quarter = {}
        if item.get("REPORTDATE"):
            quarter["report_date"] = item["REPORTDATE"][:10]
        if item.get("TOTAL_OPERATE_INCOME"):
            quarter["revenue_yi"] = round(float(item["TOTAL_OPERATE_INCOME"]) / 1e8, 2)
        if item.get("PARENT_NETPROFIT"):
            quarter["net_profit_yi"] = round(float(item["PARENT_NETPROFIT"]) / 1e8, 2)
        if item.get("BASIC_EPS"):
            quarter["eps"] = float(item["BASIC_EPS"])
        if item.get("TOTAL_OPERATE_INCOME") and item.get("YSTZ"):
            quarter["revenue_yoy"] = round(float(item["YSTZ"]), 2)
        if item.get("PARENT_NETPROFIT") and item.get("SJLTZ"):
            quarter["net_profit_yoy"] = round(float(item["SJLTZ"]), 2)
        if item.get("WEIGHTAVG_ROE"):
            quarter["roe"] = round(float(item["WEIGHTAVG_ROE"]), 2)
        if item.get("XSMLL"):
            quarter["gross_margin"] = round(float(item["XSMLL"]), 2)
        results.append(quarter)

    return results, http


def _fetch_consensus_eps(code):
    """Fetch analyst consensus: 4-year EPS forecast, ratings, target price range.

    Source: Eastmoney Datacenter report RPT_WEB_RESPREDICT.

    Note: this report has no REPORTDATE column, so we omit sortColumns
    (a previous sortColumns=REPORTDATE silently failed every request with
    success=False). Result may be null when the stock has no analyst coverage.
    """
    def _f(v):
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    def _int(v):
        try:
            return int(v) if v is not None else 0
        except (TypeError, ValueError):
            return 0

    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_WEB_RESPREDICT",
        "columns": "ALL",
        "filter": f'(SECURITY_CODE="{code}")',
        "pageNumber": "1",
        "pageSize": "5",
        "source": "WEB",
        "client": "WEB",
    }
    r = em_get(url, params=params, timeout=15)
    http = {"url": url, "status_code": r.status_code,
            "response_size": len(r.content), "response_snippet": r.text[:200]}
    j = r.json()

    # Defensive: Eastmoney returns "result": null both on failure and when the
    # stock has no forecast coverage. Treat both as "no data".
    data = (j.get("result") or {}).get("data", [])
    if not data:
        return None, http

    item = data[0]
    result = {}

    # 4-year EPS forecast (YEAR1 earliest; YEAR_MARK A=actual, E=estimate)
    forecast_years = []
    for i in range(1, 5):
        eps = _f(item.get(f"EPS{i}"))
        year = item.get(f"YEAR{i}")
        mark = item.get(f"YEAR_MARK{i}")
        if eps is not None and year is not None:
            forecast_years.append({
                "year": int(year),
                "type": mark or "",        # "A" actual / "E" estimate
                "eps": round(eps, 4),
            })
    if forecast_years:
        result["forecast_years"] = forecast_years

    # Current (first/earliest) and next-year consensus EPS
    if len(forecast_years) >= 1:
        result["consensus_eps_current"] = forecast_years[0]["eps"]
    if len(forecast_years) >= 2:
        result["consensus_eps_next"] = forecast_years[1]["eps"]

    # EPS growth rate (current -> next year). Needs positive current EPS.
    cur = result.get("consensus_eps_current")
    nxt = result.get("consensus_eps_next")
    if cur and nxt and cur > 0:
        result["eps_growth_pct"] = round((nxt - cur) / cur * 100, 2)

    # Analyst coverage + rating distribution (null categories → 0)
    if item.get("RATING_ORG_NUM") is not None:
        result["analyst_count"] = _int(item.get("RATING_ORG_NUM"))
    result["ratings"] = {
        "buy": _int(item.get("RATING_BUY_NUM")),
        "overweight": _int(item.get("RATING_ADD_NUM")),
        "neutral": _int(item.get("RATING_NEUTRAL_NUM")),
        "underweight": _int(item.get("RATING_REDUCE_NUM")),
        "sell": _int(item.get("RATING_SALE_NUM")),
    }

    # Analyst target-price range
    tp_min = _f(item.get("DEC_AIMPRICEMIN"))
    tp_max = _f(item.get("DEC_AIMPRICEMAX"))
    if tp_min is not None:
        result["target_price_min"] = round(tp_min, 2)
    if tp_max is not None:
        result["target_price_max"] = round(tp_max, 2)

    return (result if result else None), http


def _fetch_financial_health(code, periods=4):
    """Derive a lean financial-health ratio block from the three statements.

    Fetches 资产负债表 / 现金流量表 / 利润表 via akshare (sina) and computes
    pre-derived ratios over the last N common reporting periods:

      - goodwill_yi / goodwill_to_equity_pct   (商誉占比 — impairment exposure)
      - debt_ratio_pct                          (资产负债率 trend)
      - current_ratio / quick_ratio             (流动性)
      - ocf_yi / capex_yi / fcf_yi              (现金流与资本开支)
      - net_profit_parent_yi / ocf_to_ni_ratio  (归母净利 + 盈利质量)

    Returns None on structural failure (akshare missing / fetch error / no
    overlapping periods); per-field gaps degrade to null. Note: sina 利润表
    does not expose 扣非净利润 (reported only in the notes), so 扣非 is not
    derivable here.
    """
    try:
        import akshare as ak
    except Exception as e:
        record_call("fundamentals/akshare_internal", success=False, error=str(e))
        return None

    # Exchange prefix: 6/9→sh, 8→bj, else sz (mirrors http_helpers tencent logic)
    prefix = "bj" if code.startswith("8") else ("sh" if code.startswith(("6", "9")) else "sz")
    sym = f"{prefix}{code}"

    BS_COLS = ["报告日", "商誉", "资产总计", "负债合计", "归属于母公司股东权益合计",
               "流动资产合计", "流动负债合计", "存货"]
    CF_COLS = ["报告日", "经营活动产生的现金流量净额",
               "购建固定资产、无形资产和其他长期资产所支付的现金"]
    IS_COLS = ["报告日", "归属于母公司所有者的净利润"]

    def load(statement, want):
        """Return {报告日(YYYYMMDD): {col: float|None}} for present columns."""
        df = None
        for attempt in range(2):  # retry once on transient failure
            try:
                df = ak.stock_financial_report_sina(stock=sym, symbol=statement)
                break
            except Exception:
                if attempt == 0:
                    import time; time.sleep(0.5)
                else:
                    return {}
        if df is None or getattr(df, "empty", True):
            return {}
        # Defend against duplicate column labels (sina occasionally repeats).
        df = df.loc[:, ~df.columns.duplicated()]
        if "报告日" not in df.columns:
            return {}
        out = {}
        for _, row in df.iterrows():
            d = str(row["报告日"]).strip()[:8]
            if not (d.isdigit() and len(d) == 8):
                continue
            rec = {}
            for c in want[1:]:  # skip 报告日
                if c not in df.columns:
                    continue
                v = row[c]
                try:
                    fv = float(v)
                    # Coerce NaN/inf (pandas missing → NaN) to None so the
                    # emitted JSON stays valid (json.dumps emits bare NaN).
                    rec[c] = fv if math.isfinite(fv) else None
                except (TypeError, ValueError):
                    rec[c] = None
            out[d] = rec
        return out

    bs_map = load("资产负债表", BS_COLS)
    cf_map = load("现金流量表", CF_COLS)
    is_map = load("利润表", IS_COLS)
    if not (bs_map and cf_map and is_map):
        return None
    return _derive_financial_health(bs_map, cf_map, is_map, periods)


def _percentile_of_latest(values):
    """当前值（序列最后一个）在该序列里的百分位（0-100），手写避免 numpy/scipy 依赖。
    返回 None 当序列过短（<30 个有效点，分位无统计意义）或当前值缺失。
    例：序列 [10,20,30,40,50]，当前值 50 → 排在最高 → 100.0。"""
    clean = [v for v in values if v is not None and isinstance(v, (int, float)) and v > 0]
    if len(clean) < 30:
        return None
    current = clean[-1]
    below = sum(1 for v in clean if v < current)
    # 用 "低于当前值的比例" 定义分位：50 个点里 40 个低于当前 → 80.0（偏贵）
    return round(below / (len(clean) - 1) * 100, 1)


def _fetch_valuation_percentile(code, window_years=5):
    """Fetch PE(TTM)/PB historical percentile via akshare baidu valuation.

    Source: ak.stock_zh_valuation_baidu(symbol=纯6位, indicator, period="近十年")
    → DataFrame[date, value]，10 年日线序列（~731 行）。裁剪到最近 5 年后算
    当前值的百分位。治"PE 绝对值无法判断贵贱"的盲区。

    Returns None on structural failure (akshare missing / fetch error / series
    too short for a meaningful percentile). Both indicators fail → None.
    """
    try:
        import akshare as ak
    except Exception as e:
        record_call("fundamentals/akshare_baidu", success=False, error=str(e))
        return None

    result = {}
    for indicator, key in (("市盈率(TTM)", "pe_percentile"), ("市净率", "pb_percentile")):
        try:
            df = ak.stock_zh_valuation_baidu(symbol=code, indicator=indicator, period="近十年")
            if df is None or len(df) == 0:
                continue
            # 裁剪到最近 window_years 年（按 date 列过滤）
            # date 可能是 datetime.date 对象或 'YYYY-MM-DD' 字符串，统一转 str 比较
            if "date" in df.columns:
                last_date = str(df['date'].iloc[-1])
                cutoff = f"{int(last_date[:4]) - window_years}-01-01"
                df = df[df["date"].astype(str) >= cutoff]
            values = df["value"].tolist() if "value" in df.columns else []
            pct = _percentile_of_latest(values)
            if pct is not None:
                result[key] = pct
        except Exception:
            # 单指标失败不影响另一个（PE/PB 独立），整体都失败则 result 为空
            continue

    return result if result else None


def _derive_financial_health(bs_map, cf_map, is_map, periods=4):
    """Pure derivation: parsed statement maps → financial_health block.

    Maps are {报告日(YYYYMMDD): {col: float|None}}. Returns None when no
    period is common to all three statements; per-field gaps degrade to
    None. Separated from the network fetch so the ratio math is unit-testable.
    """
    # Most-recent periods present in ALL three statements.
    common = sorted(set(bs_map) & set(cf_map) & set(is_map), reverse=True)[:periods]
    if not common:
        return None

    _PTYPE = {"0331": "Q1", "0630": "H1", "0930": "Q3", "1231": "FY"}

    def ratio(num, den, scale=1.0):
        if num is None or den is None or den == 0:
            return None
        return round(num / den * scale, 2)

    YI = 1e8
    rows = []
    for d in common:
        b, c, i = bs_map[d], cf_map[d], is_map[d]
        goodwill = b.get("商誉")
        equity = b.get("归属于母公司股东权益合计")
        tot_a = b.get("资产总计")
        tot_l = b.get("负债合计")
        cur_a = b.get("流动资产合计")
        cur_l = b.get("流动负债合计")
        inv = b.get("存货")
        ocf = c.get("经营活动产生的现金流量净额")
        capex = c.get("购建固定资产、无形资产和其他长期资产所支付的现金")
        npp = i.get("归属于母公司所有者的净利润")
        inv_eff = inv if inv is not None else 0.0

        rows.append({
            "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
            "period_type": _PTYPE.get(d[4:], "?"),
            "goodwill_yi": round(goodwill / YI, 2) if goodwill is not None else None,
            "goodwill_to_equity_pct": ratio(goodwill, equity, 100),
            "debt_ratio_pct": ratio(tot_l, tot_a, 100),
            "current_ratio": ratio(cur_a, cur_l),
            "quick_ratio": ratio(cur_a - inv_eff if cur_a is not None else None, cur_l),
            "ocf_yi": round(ocf / YI, 2) if ocf is not None else None,
            "capex_yi": round(capex / YI, 2) if capex is not None else None,
            "fcf_yi": round((ocf - capex) / YI, 2) if (ocf is not None and capex is not None) else None,
            "net_profit_parent_yi": round(npp / YI, 2) if npp is not None else None,
            "ocf_to_ni_ratio": ratio(ocf, npp),
        })

    latest = rows[0]
    gw = latest.get("goodwill_to_equity_pct")
    ocfni = latest.get("ocf_to_ni_ratio")
    return {
        "periods": rows,
        "latest": latest,
        "goodwill_impairment_risk": gw is not None and gw > 30,
        "ocf_quality": ("good" if ocfni is not None and ocfni >= 1
                        else "ok" if ocfni is not None and ocfni >= 0.5
                        else "weak"),
        "notes": [
            "扣非净利润: sina 利润表未提供，无法计算扣非/归母比",
            "OCF/净利/资本开支为累计值，跨期比较须注意期间长度 (period_type)",
        ],
    }


def _calc_arbr(df, period=26):
    """Calculate ARBR indicators from OHLCV DataFrame.

    AR = SUM(H-O, period) / SUM(O-L, period) * 100
    BR = SUM(H-prev_close, period) / SUM(prev_close-L, period) * 100

    兼容英文列名（mootdx: open/high/low/close）和中文列名（akshare: 开盘/最高/最低/收盘）。
    Returns dict with ar, br, signals, and historical stats.
    """
    if df is None or len(df) < period + 1:
        return None
    try:
        def pick(key_en, key_cn):
            return df[key_en] if key_en in df.columns else df[key_cn]
        h = pick("high", "最高").astype(float).values
        o = pick("open", "开盘").astype(float).values
        l = pick("low", "最低").astype(float).values
        c = pick("close", "收盘").astype(float).values
    except (KeyError, ValueError):
        return None

    n = len(h)
    ar_parts_ho, ar_parts_ol = [], []
    br_parts_hc, br_parts_cl = [], []
    for i in range(max(0, n - period), n):
        ar_parts_ho.append(h[i] - o[i])
        ar_parts_ol.append(o[i] - l[i])
    for i in range(max(0, n - period), n):
        prev = c[i - 1] if i > 0 else o[i]
        br_parts_hc.append(h[i] - prev)
        br_parts_cl.append(prev - l[i])

    sum_ho = sum(ar_parts_ho)
    sum_ol = sum(ar_parts_ol)
    ar = round(sum_ho / sum_ol * 100, 2) if sum_ol != 0 else None

    sum_hc = sum(br_parts_hc)
    sum_cl = sum(br_parts_cl)
    br = round(sum_hc / sum_cl * 100, 2) if sum_cl != 0 else None

    signals = []
    if ar is not None:
        if ar > 150:
            signals.append("AR>150: 超买信号(卖出)")
        elif ar < 70:
            signals.append("AR<70: 超卖信号(买入)")
    if br is not None:
        if br > 300:
            signals.append("BR>300: 超买信号(卖出)")
        elif br < 50:
            signals.append("BR<50: 超卖信号(买入)")

    return {"ar": ar, "br": br, "period": period, "signals": signals}


def _fetch_market_sentiment_extra(code, date):
    """Fetch ARBR(26日) + turnover interpretation for cross-validation.

    Returns dict with arbr and turnover fields, or None on total failure.

    ARBR 用 mootdx（通达信 TCP，稳定）拉日K——旧实现用 ak.stock_zh_a_hist（新浪 HTTP）
    被持续封禁导致 ARBR 恒失败；mootdx 与 kline.py 同源，0.1s 拿 160 根日K。
    """
    result = {}

    # ARBR: mootdx 日K（~160 根，覆盖 26 日周期 + 余量）
    try:
        from mootdx.quotes import Quotes
        market = 1 if code.startswith("6") else 0
        quotes = Quotes.factory(market=market, timeout=10)
        df = quotes.bars(symbol=code, category=9, start=0, offset=160)
        if df is not None and len(df) >= 30:
            arbr = _calc_arbr(df, period=26)
            if arbr:
                result["arbr"] = arbr
    except Exception:
        pass

    # Turnover: from tencent_quote（与 valuation 阶段同源）
    # 注意：tencent_quote 返回 (dict, http_stats) 元组，必须解包两个值。
    # 老实现 `tq = tencent_quote([code])` 漏解包 → tq 是元组 → `code in tq` 恒 false → 换手率恒缺失
    valuation = None
    try:
        tq, _ = tencent_quote([code])
        if code in tq:
            valuation = tq[code]
    except Exception:
        pass

    if valuation:
        tp = valuation.get("turnover_pct", 0)
        if tp < 1:
            turnover_label = "低迷"
        elif tp < 3:
            turnover_label = "正常"
        elif tp < 7:
            turnover_label = "活跃"
        elif tp < 15:
            turnover_label = "高度活跃"
        else:
            turnover_label = "异常活跃"
        result["turnover"] = {
            "value": tp,
            "label": turnover_label,
        }

    return result if result else None


def main():
    parser = argparse.ArgumentParser(description="Fetch fundamental data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code (e.g. SH600519)")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_fundamentals(args.ticker, args.date)
        if data is None:
            output_json(False, error="fetch_fundamentals returned no data")
        else:
            output_json(True, data=data, source="tencent+mootdx+eastmoney+akshare+pywencai")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()