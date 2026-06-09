#!/usr/bin/env python3
"""Fetch lockup expiry, insider transactions, and company announcement events."""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import eastmoney_datacenter, http_get, output_json, normalize_ticker

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def _fetch_lockup_history(code):
    """Fetch historical lockup expiry records."""
    try:
        data = eastmoney_datacenter(
            "RPT_LIFT_STAGE",
            filter_str=f'(SECURITY_CODE="{code}")',
            page_size=15,
            sort_columns="FREE_DATE",
            sort_types="-1",
        )
        return [
            {"date": str(row.get("FREE_DATE", ""))[:10],
             "type": row.get("LIMITED_STOCK_TYPE", ""),
             "shares": row.get("FREE_SHARES_NUM", ""),
             "ratio": row.get("FREE_RATIO", "")}
            for row in data
        ]
    except Exception:
        return []


def _fetch_lockup_upcoming(code, date, forward_days=90):
    """Fetch upcoming lockup expiries."""
    end_dt = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=forward_days)).strftime("%Y-%m-%d")
    try:
        data = eastmoney_datacenter(
            "RPT_LIFT_STAGE",
            filter_str=f'(SECURITY_CODE="{code}")(FREE_DATE>=\'{date}\')(FREE_DATE<=\'{end_dt}\')',
            page_size=20,
            sort_columns="FREE_DATE",
            sort_types="1",
        )
        return [
            {"date": str(row.get("FREE_DATE", ""))[:10],
             "type": row.get("LIMITED_STOCK_TYPE", ""),
             "shares": row.get("FREE_SHARES_NUM", ""),
             "ratio": row.get("FREE_RATIO", "")}
            for row in data
        ]
    except Exception:
        return []


def _fetch_insider_transactions(code):
    """Fetch insider transactions from mootdx F10."""
    try:
        from mootdx.quotes import Quotes
        market = 1 if code.startswith("6") else 0
        client = Quotes.factory(market=market, timeout=10)
        info = client.f10(symbol=int(code), name="股东变动")
        if info is not None and not (hasattr(info, 'empty') and info.empty):
            rows = []
            for _, row in info.head(10).iterrows():
                rows.append({k: str(v) for k, v in row.items()})
            return rows
    except Exception:
        pass
    return []


def _classify_announcement(title):
    """Classify a company announcement by title keywords.

    Returns (type, importance) where importance is 0-3 (3 = highest).
    Returns ("解禁", 0) for lockup-expiry notices so callers filter them out
    (already covered by _fetch_lockup_history/_upcoming).
    """
    t = title or ""
    if any(k in t for k in ("业绩预告", "业绩预增", "业绩预减",
                            "业绩预亏", "业绩预盈", "业绩快报")):
        return ("业绩预告/快报", 3)
    if any(k in t for k in ("重大资产重组", "重组", "并购", "吸收合并")):
        return ("重大重组", 3)
    if any(k in t for k in ("停牌", "复牌")):
        return ("停牌/复牌", 3)
    if any(k in t for k in ("问询函", "关注函", "监管措施", "处罚", "立案", "警示")):
        return ("监管/处罚", 2)
    if "回购" in t:
        return ("回购", 2)
    if any(k in t for k in ("增发", "配股", "公开发行")):
        return ("增发/配股", 2)
    if "增持" in t:
        return ("股东增持", 2)
    if "减持" in t:
        return ("股东减持", 2)
    if any(k in t for k in ("分红", "派息", "除权", "除息", "送转", "股权登记")):
        return ("分红派息", 1)
    if any(k in t for k in ("解禁", "限售股上市", "限售股份流通")):
        return ("解禁", 0)
    return ("其他", 1)


def _fetch_announcements(code, date, lookback_days=60):
    """Fetch structured company announcements (Eastmoney ann API).

    Covers earnings pre-announcements / trading halts / buybacks / offerings /
    dividends, classified and importance-scored. Lockup-expiry notices are
    filtered out (already in lockup_history/upcoming). Returns top-8 by
    (importance, date) desc.
    """
    url = "https://np-anotice-stock.eastmoney.com/api/security/ann"
    params = {
        "ann_type": "A", "stock_list": code, "sr": "-1",
        "page_size": "50", "page_index": "1",
        "f_node": "0", "s_node": "0",
    }
    headers = {"User-Agent": _UA, "Referer": "https://data.eastmoney.com/"}
    try:
        resp = http_get(url, params=params, headers=headers, timeout=10)
        payload = resp.json()
        if not payload.get("success"):
            return []
        items = payload.get("data", {}).get("list", []) or []
    except Exception:
        return []

    cutoff = datetime.strptime(date, "%Y-%m-%d") - timedelta(days=lookback_days)
    events = []
    for item in items:
        title = (item.get("title") or "").strip()
        if not title:
            continue
        ann_type, importance = _classify_announcement(title)
        if ann_type == "解禁":
            continue  # lockup_history/upcoming already cover this
        notice_date = str(item.get("notice_date", "") or "")[:10]
        try:
            pub_dt = datetime.strptime(notice_date, "%Y-%m-%d")
        except ValueError:
            continue
        if pub_dt < cutoff:
            continue
        art_code = str(item.get("art_code", "") or "")
        events.append({
            "date": notice_date,
            "type": ann_type,
            "title": title,
            "importance": importance,
            "url": f"https://data.eastmoney.com/notices/detail/{code}/{art_code}.html" if art_code else "",
        })
    events.sort(key=lambda x: (x["importance"], x["date"]), reverse=True)
    return events[:8]


def fetch_lockup(ticker, date):
    """Fetch all lockup data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["lockup_history"] = _fetch_lockup_history(code)
    data["lockup_upcoming"] = _fetch_lockup_upcoming(code, date)
    data["insider_transactions"] = _fetch_insider_transactions(code)
    data["announcements"] = _fetch_announcements(code, date)

    # Compute pressure rating
    upcoming = data.get("lockup_upcoming", [])
    if upcoming:
        data["pressure_rating"] = "重大压力" if len(upcoming) >= 3 else "中等压力" if len(upcoming) >= 1 else "轻微压力"
    else:
        data["pressure_rating"] = "无明显压力"

    return data


def main():
    parser = argparse.ArgumentParser(description="Fetch lockup data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    args = parser.parse_args()

    try:
        data = fetch_lockup(args.ticker, args.date)
        output_json(True, data=data, source="eastmoney+mootdx+ann")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()