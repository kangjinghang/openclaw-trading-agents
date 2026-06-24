#!/usr/bin/env python3
"""Fetch lockup expiry, insider transactions, and company announcement events."""

import argparse
import json
import sys
import os
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import eastmoney_datacenter, http_get, output_json, normalize_ticker, record_call

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
    start = time.monotonic()
    url = "https://np-anotice-stock.eastmoney.com/api/security/ann"
    params = {
        "ann_type": "A", "stock_list": code, "sr": "-1",
        "page_size": "50", "page_index": "1",
        "f_node": "0", "s_node": "0",
    }
    headers = {"User-Agent": _UA, "Referer": "https://data.eastmoney.com/"}
    try:
        resp = http_get(url, params=params, headers=headers, timeout=10)
        _http = dict(url=str(resp.url)[:200], status_code=resp.status_code,
                     response_size=len(resp.content), response_snippet=resp.text[:200])
        payload = resp.json()
        if not payload.get("success"):
            record_call("lockup/ann_em", success=False, error="API returned no success",
                        duration_ms=(time.monotonic() - start) * 1000, **_http)
            return []
        items = payload.get("data", {}).get("list", []) or []
    except Exception as e:
        record_call("lockup/ann_em", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
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
    record_call("lockup/ann_em", success=True, duration_ms=(time.monotonic() - start) * 1000,
                url=str(resp.url)[:200], status_code=resp.status_code, response_size=len(resp.content))
    return events[:8]


def _fetch_reduce_em(code, date=None):
    """Fetch Eastmoney reduce holdings information."""
    start = time.monotonic()
    filter_date = date or datetime.now().strftime("%Y-%m-%d")
    try:
        data = eastmoney_datacenter(
            "RPT_REDUCED_HOLDINGS",
            filter_str=f'(SECURITY_CODE="{code}")(REDUCE_DATE>={filter_date})',
            page_size=10,
            sort_columns="REDUCE_DATE",
            sort_types="-1",
        )
        result = [
            {
                "date": str(row.get("REDUCE_DATE", ""))[:10],
                "reducing_shareholder": row.get("REDUCING_SHAREHOLDER", ""),
                "reducing_shares": row.get("REDUCING_SHARES", ""),
                "reducing_ratio": row.get("REDUCING_RATIO", ""),
                "reduce_reason": row.get("REDUCE_REASON", ""),
            }
            for row in data
        ]
        record_call("lockup/reduce_em", success=True, duration_ms=(time.monotonic() - start) * 1000)
        return result
    except Exception as e:
        record_call("lockup/reduce_em", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
        return []


# ── 融资融券（margin trading）────────────────────────────────────────
# 数据源：东方财富 datacenter RPTA_WEB_RZRQ_GGMX（个股融资融券明细）。
# 优势 vs aiagents-stock 的 stock_margin_underlying_info_szse：
#   - 沪深全覆盖（szse 接口只覆盖深市，沪市 6 开头股完全拿不到）
#   - 按 SCODE 精确过滤（后者拉全市场表再逐只筛，逐股查询低效）
#   - 字段更全：含 3/5/10 日累计净买入、融资余额占流通市值比（踩踏风险关键指标）
# 非"两融标的"的股票接口返回 success:false/result:null —— 这是合法结果（多数小盘股
# 非标的），返回 None 让上游据实标注，不算源故障。接口异常才记 record_call 失败。

_MARGIN_DAYS = 10  # 取近 10 个交易日明细做趋势


def _to_float(val):
    """Best-effort numeric coerce (东财字段偶有 None/字符串)."""
    try:
        return float(val) if val is not None else None
    except (ValueError, TypeError):
        return None


def _score_margin(rows):
    """预计算多空杠杆信号（遵循 openclaw 约定：算术在脚本内完成，禁止 LLM 重算）。

    Args:
        rows: 东财明细列表，已按日期降序（rows[0] = 最新），字段为原始大写名。
    Returns:
        (signal dict, latest row dict)。rows 为空或字段缺失时 signal 各项为 None。
    """
    latest = rows[0] if rows else {}

    def g(key):
        return _to_float(latest.get(key))

    rzye = g("RZYE")          # 融资余额（元）
    rqye = g("RQYE")          # 融券余额（元）
    rzyezb = g("RZYEZB")      # 融资余额占流通市值比（%）
    rzjme = g("RZJME")        # 当日融资净买入（元）
    rzjme_3d = g("RZJME3D")   # 近 3 日累计融资净买入（元）
    rzjme_5d = g("RZJME5D")
    rzjme_10d = g("RZJME10D")

    signal = {
        "margin_balance": rzye,
        "short_balance": rqye,
        "margin_pct_of_float": rzyezb,
        "net_buy_1d": rzjme,
        "net_buy_3d": rzjme_3d,
        "net_buy_5d": rzjme_5d,
        "net_buy_10d": rzjme_10d,
    }

    # 多空杠杆倾向：融资（看多杠杆）vs 融券（看空杠杆）。
    # ratio>10 视为强看多杠杆，<3 偏平衡/看空（参考 aiagents-stock 阈值）。
    if rzye is not None and rqye is not None and rqye > 0:
        ratio = rzye / rqye
        signal["long_short_ratio"] = ratio
        if ratio > 10:
            signal["leverage_bias"] = "看多杠杆强"
        elif ratio > 3:
            signal["leverage_bias"] = "偏看多"
        else:
            signal["leverage_bias"] = "多空相对平衡"

    # 融资余额占流通市值比 → 踩踏风险预警。
    # 经验阈值：>10% 高杠杆拥挤（下跌易触发强平连锁），5-10% 中等，<5% 偏低。
    if rzyezb is not None:
        if rzyezb >= 10:
            signal["margin_pressure"] = "高杠杆拥挤（下跌易触发融资强平）"
        elif rzyezb >= 5:
            signal["margin_pressure"] = "中等杠杆"
        else:
            signal["margin_pressure"] = "杠杆偏低"

    # 资金流向方向（近 3/5/10 日累计净买入正负）。
    for win, key in (("3d", "net_buy_3d"), ("5d", "net_buy_5d"), ("10d", "net_buy_10d")):
        v = signal[key]
        if v is not None:
            signal[f"flow_{win}"] = "净流入（杠杆资金看多）" if v > 0 else ("净流出（杠杆资金撤退）" if v < 0 else "持平")

    return signal, latest


def _fetch_margin(code):
    """Fetch individual-stock margin trading data (融资融券明细).

    Returns None if the stock is NOT a margin-eligible underlying (success:false
    from the API — most small-caps aren't), which is a legitimate empty result.
    Returns a dict with history + signal on success. Records a failed call only
    on genuine API errors (so non-margin stocks don't pollute health stats).
    """
    start = time.monotonic()
    try:
        data = eastmoney_datacenter(
            "RPTA_WEB_RZRQ_GGMX",
            filter_str=f'(SCODE="{code}")',
            page_size=_MARGIN_DAYS,
            sort_columns="DATE",
            sort_types="-1",
        )
    except Exception as e:
        record_call("lockup/margin_em", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000)
        return None

    if not data:
        # 非"两融标的" → API returns success:false/result:null → eastmoney_datacenter
        # returns []. 这是合法空结果，不计为源故障。
        return None

    signal, latest = _score_margin(data)
    record_call("lockup/margin_em", success=True,
                duration_ms=(time.monotonic() - start) * 1000)

    # 输出：最近明细（归一为易读字段，数值转亿/万）+ 预计算信号。
    history = []
    for row in data:
        rzye = _to_float(row.get("RZYE"))
        rqye = _to_float(row.get("RQYE"))
        history.append({
            "date": str(row.get("DATE", ""))[:10],
            "margin_balance": rzye,            # 融资余额（元）
            "short_balance": rqye,             # 融券余额（元）
            "margin_pct_of_float": _to_float(row.get("RZYEZB")),  # 占流通市值 %
            "net_buy": _to_float(row.get("RZJME")),               # 当日融资净买入（元）
            "net_buy_3d": _to_float(row.get("RZJME3D")),
            "net_buy_5d": _to_float(row.get("RZJME5D")),
            "net_buy_10d": _to_float(row.get("RZJME10D")),
        })

    return {
        "latest_date": str(latest.get("DATE", ""))[:10],
        "is_margin_underlying": True,
        "history": history,
        "signal": signal,
    }


def fetch_lockup(ticker, date):
    """Fetch all lockup data."""
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    data["lockup_history"] = _fetch_lockup_history(code)
    data["lockup_upcoming"] = _fetch_lockup_upcoming(code, date)
    data["insider_transactions"] = _fetch_insider_transactions(code)
    data["announcements"] = _fetch_announcements(code, date)
    data["reduce_holdings"] = _fetch_reduce_em(code, date)
    data["margin_trading"] = _fetch_margin(code)

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