#!/usr/bin/env python3
"""Fetch fundamental data for A-share stocks (PE/PB/financials/EPS forecast)."""

import argparse
import json
import sys
import os

# Add parent skills dir to path for shared imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import tencent_quote, em_get, output_json, normalize_ticker


def fetch_fundamentals(ticker, date):
    """Fetch fundamentals from Tencent (valuation) + mootdx (financials) + Eastmoney (EPS)."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    # 1. Tencent: real-time valuation
    try:
        tq = tencent_quote([code])
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
    except Exception as e:
        data["valuation_error"] = str(e)

    # 2. mootdx: quarterly financial snapshot (expanded fields)
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
                "zichanfuzhailv": "debt_ratio",
                "xishoumaoliv": "gross_margin",
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
    except Exception as e:
        data["financial_snapshot_error"] = str(e)

    # 3. Eastmoney: basic stock info
    try:
        market_code = 1 if code.startswith("6") else 0
        url = "https://push2.eastmoney.com/api/qt/stock/get"
        params = {
            "fltt": "2", "invt": "2",
            "fields": "f57,f58,f84,f85,f127,f116,f117,f189,f43",
            "secid": f"{market_code}.{code}",
        }
        r = em_get(url, params=params, timeout=10)
        d = r.json().get("data", {})
        if d:
            info = {}
            if d.get("f127"):
                info["industry"] = d["f127"]
            if d.get("f84"):
                info["total_shares"] = d["f84"]
            if d.get("f85"):
                info["float_shares"] = d["f85"]
            if d.get("f116"):
                info["total_mv"] = d["f116"]
            if info:
                data["stock_info"] = info
    except Exception as e:
        data["stock_info_error"] = str(e)

    # 4. Eastmoney Datacenter: quarterly financial trends (last 4 quarters)
    try:
        data["quarterly_trends"] = _fetch_quarterly_financials(code)
    except Exception as e:
        data["quarterly_trends_error"] = str(e)

    # 5. Eastmoney: consensus EPS / target price / ratings
    try:
        data["consensus_eps"] = _fetch_consensus_eps(code)
    except Exception as e:
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

    return data


def _fetch_quarterly_financials(code):
    """Fetch last 4 quarters of revenue/net profit/EPS/YoY from Eastmoney Datacenter."""
    market_code = "1" if code.startswith("6") else "0"
    secid = f"{market_code}.{code}"

    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_LICO_FN_CPD",
        "columns": "ALL",
        "filter": f'(SECURITY_CODE="{code}")',
        "pageNumber": "1",
        "pageSize": "5",
        "sortColumns": "REPORT_DATE",
        "sortTypes": "-1",
        "source": "WEB",
        "client": "WEB",
    }
    r = em_get(url, params=params, timeout=15)
    d = r.json()

    results = []
    items = d.get("result", {}).get("data", [])
    for item in (items or [])[:4]:
        quarter = {}
        if item.get("REPORT_DATE"):
            quarter["report_date"] = item["REPORT_DATE"][:10]
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

    return results


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
    j = r.json()

    # Defensive: Eastmoney returns "result": null both on failure and when the
    # stock has no forecast coverage. Treat both as "no data".
    data = (j.get("result") or {}).get("data", [])
    if not data:
        return None

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

    return result if result else None


def main():
    parser = argparse.ArgumentParser(description="Fetch fundamental data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code (e.g., 600519)")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_fundamentals(args.ticker, args.date)
        output_json(True, data=data, source="tencent+mootdx+eastmoney")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()