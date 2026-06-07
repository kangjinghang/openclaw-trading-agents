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
    """Fetch analyst consensus EPS / target price / rating from Eastmoney."""
    market_code = "1" if code.startswith("6") else "0"
    secid = f"{market_code}.{code}"

    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_WEB_RESPREDICT",
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
    d = r.json()

    items = d.get("result", {}).get("data", [])
    if not items:
        return None

    item = items[0]
    result = {}
    if item.get("PREDICT_EPS_THISYEAR"):
        result["consensus_eps"] = round(float(item["PREDICT_EPS_THISYEAR"]), 2)
    if item.get("PREDICT_EPS_NEXTYEAR"):
        result["consensus_eps_next_year"] = round(float(item["PREDICT_EPS_NEXTYEAR"]), 2)
    if item.get("TARGET_PRICE"):
        result["target_price"] = round(float(item["TARGET_PRICE"]), 2)
    if item.get("RESEARCHER_NUM"):
        result["analyst_count"] = int(item["RESEARCHER_NUM"])
    if item.get("RATING"):
        result["avg_rating"] = item["RATING"]

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