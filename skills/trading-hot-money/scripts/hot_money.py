#!/usr/bin/env python3
"""Fetch hot money / capital flow data for A-share stocks (northbound, fund flow, dragon-tiger board)."""

import argparse
import json
import sys
import os
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_shared"))
from http_helpers import http_get, eastmoney_datacenter, output_json, normalize_ticker, record_call

import requests


def _fetch_northbound():
    """Fetch northbound capital flow from 同花顺 hsgtApi."""
    start = time.monotonic()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36",
        "Host": "data.hexin.cn",
        "Referer": "https://data.hexin.cn/",
    }
    try:
        url = "https://data.hexin.cn/market/hsgtApi/method/dayChart/"
        r = http_get(url, headers=headers, timeout=10)
        d = r.json()
        times = d.get("time", [])
        hgt = d.get("hgt", [])
        sgt = d.get("sgt", [])
        if not times:
            record_call("hot_money/northbound", success=False, error="No data returned",
                        duration_ms=(time.monotonic() - start) * 1000,
                        url=url, status_code=r.status_code, response_size=len(r.content),
                        response_snippet=r.text)
            return None
        hgt_close = float(hgt[-1]) if hgt else 0
        sgt_close = float(sgt[-1]) if sgt else 0
        result = {
            "hgt_close": hgt_close,
            "sgt_close": sgt_close,
            "total": hgt_close + sgt_close,
            "signal": "inflow" if (hgt_close + sgt_close) > 0 else "outflow",
            "recent_points": [
                {"time": times[i], "hgt": float(hgt[i]) if i < len(hgt) else 0,
                 "sgt": float(sgt[i]) if i < len(sgt) else 0}
                for i in range(max(0, len(times) - 10), len(times))
            ],
        }
        record_call("hot_money/northbound", success=True, duration_ms=(time.monotonic() - start) * 1000,
                    url=url, status_code=r.status_code, response_size=len(r.content),
                    response_snippet=r.text)
        return result
    except Exception as e:
        record_call("hot_money/northbound", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
        return None


def _fetch_hot_stocks(date):
    """Fetch hot stocks with topic attribution from 同花顺."""
    start = time.monotonic()
    try:
        url = (
            f"http://zx.10jqka.com.cn/event/api/getharden/"
            f"date/{date}/orderby/date/orderway/desc/charset/GBK/"
        )
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36"}
        r = http_get(url, headers=headers, timeout=10)
        data = r.json()
        if data.get("errocode", 0) != 0:
            record_call("hot_money/hot_stocks", success=False, error="API error code: " + str(data.get("errocode")),
                        duration_ms=(time.monotonic() - start) * 1000,
                        url=url, status_code=r.status_code, response_size=len(r.content),
                        response_snippet=r.text)
            return None
        rows = data.get("data") or []
        result = [
            {"code": row.get("code"), "name": row.get("name"),
             "reason": row.get("reason", ""), "change_pct": row.get("zhangfu", "")}
            for row in rows[:20]
        ]
        record_call("hot_money/hot_stocks", success=True, duration_ms=(time.monotonic() - start) * 1000,
                    url=url, status_code=r.status_code, response_size=len(r.content),
                    response_snippet=r.text)
        return result
    except Exception as e:
        record_call("hot_money/hot_stocks", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
        return None


def _fetch_dragon_tiger(code, date, lookback=30):
    """Fetch dragon-tiger board appearances with buy/sell amounts."""
    start_dt = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=lookback)).strftime("%Y-%m-%d")
    start = time.monotonic()
    try:
        data, http = eastmoney_datacenter(
            "RPT_DAILYBILLBOARD_DETAILSNEW",
            filter_str=f'(TRADE_DATE>=\'{start_dt}\')(TRADE_DATE<=\'{date}\')(SECURITY_CODE="{code}")',
            page_size=10,
            sort_columns="TRADE_DATE",
            sort_types="-1",
        )
        if not data:
            # 空数组是合法结果（该股 30 天内未上榜），不是接口故障——
            # 之前误记 success=False 会污染数据源健康统计（误报龙虎榜源宕机）。
            record_call("hot_money/dragon_tiger", success=True, duration_ms=(time.monotonic() - start) * 1000,
                        **http)
            return []
        result = [
            {
                "date": str(row.get("TRADE_DATE", ""))[:10],
                "reason": row.get("EXPLANATION", ""),
                "net_buy": round((row.get("BILLBOARD_NET_AMT") or 0) / 10000, 1),
                "buy_amt": round((row.get("BILLBOARD_BUY_AMT") or 0) / 10000, 1),
                "sell_amt": round((row.get("BILLBOARD_SELL_AMT") or 0) / 10000, 1),
                "turnover": round(float(row.get("TURNOVERRATE") or 0), 2),
                "close_price": round(float(row.get("CLOSE_PRICE") or 0), 2),
                "change_rate": round(float(row.get("CHANGE_RATE") or 0), 2),
            }
            for row in data
        ]
        record_call("hot_money/dragon_tiger", success=True, duration_ms=(time.monotonic() - start) * 1000,
                    **http)
        return result
    except Exception as e:
        record_call("hot_money/dragon_tiger", success=False, error=str(e), duration_ms=(time.monotonic() - start) * 1000)
        return []


# ── Dragon-tiger 5-dimension scoring ────────────────────────────────
# Borrowed from aiagents-stock's LonghubangScoring. The upstream version keys
# off dedicated 游资名称/营业部/概念 columns, but our dragon-tiger records (see
# _fetch_dragon_tiger) carry a single free-text `reason` field that folds seat
# names and concepts together (e.g. "赵老哥买入AI芯片"). So scoring matches
# keyword lists against that text. 5 dimensions, composite capped at 100.

_KNOWN_HOT_MONEY = frozenset({
    "赵老哥", "章盟主", "92科比", "瑞鹤仙", "小鳄鱼", "养家心法", "欢乐海岸",
    "古北路", "成都系", "佛山系", "方新侠", "乔帮主", "淮海路",
    "国信深圳", "华泰深圳", "中信杭州", "招商深圳",
})

_INSTITUTION_KEYWORDS = frozenset({
    "机构专用", "机构", "基金", "保险", "社保", "QFII", "RQFII", "券商", "信托",
})

_HOT_CONCEPTS = frozenset({
    "人工智能", "AI", "ChatGPT", "算力", "新能源", "芯片", "半导体",
    "军工", "医药", "消费", "5G", "新材料", "量子", "光伏", "储能",
    "锂电池", "汽车", "游戏", "传媒", "元宇宙", "数据要素", "低空经济",
    "机器人", "华为", "卫星", "光刻",
})


def _score_dragon_tiger(records):
    """Score dragon-tiger records on 5 dimensions (0-100, composite capped).

    Each record carries a free-text ``reason`` (seat names + concepts), plus
    ``net_buy``/``buy_amt``/``sell_amt`` in 万元. Returns a list of scored
    dicts sorted by composite_score descending, or None when records is empty.

    Dimensions (mirroring aiagents-stock LonghubangScoring):
      1. 资金含金量 (capital_quality, 30pts): known hot-money +10, institution +5, else +1.5
      2. 净买入额 (net_inflow, 25pts): tiered by 万元 magnitude
      3. 卖出压力 (sell_pressure, 20pts): inverse of sell/buy ratio
      4. 机构共振 (institution_resonance, 15pts): institution+hot-money > institution > hot-money
      5. 加分项 (bonus, 10pts): hot concepts + net-buy ratio + large buy
    """
    if not records:
        return None

    scored = []
    for rec in records:
        net_buy = rec.get("net_buy", 0) or 0
        buy_amt = rec.get("buy_amt", 0) or 0
        sell_amt = rec.get("sell_amt", 0) or 0
        reason = str(rec.get("reason", ""))

        scores = {}

        # 1. 资金含金量 (0-30): text-scan reason for known names
        quality = 1.5  # ordinary baseline
        for name in _KNOWN_HOT_MONEY:
            if name in reason:
                quality = max(quality, 10.0)
        for kw in _INSTITUTION_KEYWORDS:
            if kw in reason:
                quality = max(quality, 5.0)
        scores["capital_quality"] = round(min(quality, 30), 1)

        # 2. 净买入额 (0-25): tiered by 万元 (net_buy is already in 万元)
        if net_buy < 1000:
            inflow_pts = net_buy / 1000 * 10
        elif net_buy < 5000:
            inflow_pts = 10 + (net_buy - 1000) / 4000 * 8
        elif net_buy < 10000:
            inflow_pts = 18 + (net_buy - 5000) / 5000 * 4
        else:
            inflow_pts = 22 + min((net_buy - 10000) / 10000 * 3, 3)
        scores["net_inflow"] = round(max(0.0, min(inflow_pts, 25)), 1)

        # 3. 卖出压力 (0-20): inverse of sell/buy ratio
        if buy_amt > 0:
            sell_ratio = sell_amt / buy_amt
            if sell_ratio < 0.1:
                pressure_pts = 20.0
            elif sell_ratio < 0.3:
                pressure_pts = 20.0 - (sell_ratio - 0.1) / 0.2 * 5
            elif sell_ratio < 0.5:
                pressure_pts = 15.0 - (sell_ratio - 0.3) / 0.2 * 5
            elif sell_ratio < 0.8:
                pressure_pts = 10.0 - (sell_ratio - 0.5) / 0.3 * 5
            else:
                pressure_pts = 5.0 - min(sell_ratio - 0.8, 0.2) / 0.2 * 5
        else:
            pressure_pts = 0.0
        scores["sell_pressure"] = round(max(0.0, min(pressure_pts, 20)), 1)

        # 4. 机构共振 (0-15)
        has_institution = any(kw in reason for kw in _INSTITUTION_KEYWORDS)
        has_hot_money = any(name in reason for name in _KNOWN_HOT_MONEY)
        if has_institution and has_hot_money:
            resonance = 15.0
        elif has_institution:
            resonance = 10.0
        elif has_hot_money:
            resonance = 7.0
        else:
            resonance = 3.0
        scores["institution_resonance"] = round(resonance, 1)

        # 5. 加分项 (0-10): hot concepts + net-buy ratio + large buy
        bonus = 0.0
        bonus += min(sum(1 for c in _HOT_CONCEPTS if c in reason) * 0.3, 3.0)
        if net_buy > 0 and buy_amt > 0:
            ratio = net_buy / buy_amt
            if ratio > 0.8:
                bonus += 2.0
            elif ratio > 0.5:
                bonus += 1.0
        if buy_amt > 5000:  # 单席买入 > 5000万
            bonus += 1.0
        scores["bonus"] = round(min(bonus, 10), 1)

        composite = round(min(sum(scores.values()), 100), 1)
        scores["composite_score"] = composite
        scored.append(scores)

    scored.sort(key=lambda x: x["composite_score"], reverse=True)
    return scored


def _fetch_sector_fund_flow(top_n=8):
    """Fetch industry board fund-flow ranking (主力净流入) from 同花顺 10jqka.

    Board rotation is a primary A-share driver. Returns top-N inflow and
    top-N outflow industry boards so the LLM can read main theme (主线) vs
    weak (弱势) camps. Source: akshare stock_fund_flow_industry (同花顺 hyzjl).
    Replaces the old 东财 push2 source (push2.eastmoney.com 被持续封禁).

    同花顺 净额 单位是「亿」(与东财 f62/1e8 对齐)，无超大单净额
    (super_net_yi 置 0；下游只用 name + main_net_yi)。

    Note: akshare uses py_mini_racer (JS runtime) for anti-bot hexin-v header
    + BeautifulSoup HTML parsing — not feasible to inline. Trace records the
    request URL and DataFrame row count as response_size proxy.
    """
    _URL = "http://data.10jqka.com.cn/funds/hyzjl/field/tradezdf/order/desc/ajax/1/free/1/"
    start = time.monotonic()
    try:
        import akshare as ak
        df = ak.stock_fund_flow_industry(symbol="即时")
        boards = [
            {
                "name": str(row.get("行业", "")),
                "change_pct": row.get("行业-涨跌幅", 0),
                "main_net_yi": round(float(row.get("净额", 0) or 0), 2),
                "super_net_yi": 0,  # 同花顺不提供超大单净额
            }
            for _, row in df.iterrows()
        ]
        record_call("hot_money/sector_fund_flow", success=True,
                    duration_ms=(time.monotonic() - start) * 1000,
                    url=_URL, response_size=len(df))
    except Exception as e:
        record_call("hot_money/sector_fund_flow", success=False, error=str(e),
                    duration_ms=(time.monotonic() - start) * 1000,
                    url=_URL)
        return None

    if not boards:
        record_call("hot_money/sector_fund_flow", success=False, error="No items returned",
                    duration_ms=(time.monotonic() - start) * 1000,
                    url=_URL)
        return None

    boards_sorted = sorted(boards, key=lambda x: x["main_net_yi"], reverse=True)
    result = {
        "inflow_top": boards_sorted[:top_n],
        "outflow_top": list(reversed(boards_sorted[-top_n:])),
        "total_boards": len(boards_sorted),
    }
    return result


def fetch_hot_money(ticker, date, global_data=None):
    """Fetch all hot money data.

    Args:
        global_data: Optional pre-fetched global data dict with keys
            northbound/sector_fund_flow/hot_stocks. When provided,
            these sources are NOT fetched again (saving N-1 duplicate HTTP calls).
            Per-stock source (dragon_tiger) is always fetched.
    """
    code = normalize_ticker(ticker)
    data = {"ticker": code, "date": date}

    if global_data:
        data["northbound"] = global_data.get("northbound")
        data["sector_fund_flow"] = global_data.get("sector_fund_flow")
        data["hot_stocks"] = global_data.get("hot_stocks")
    else:
        # 无全局预取（global-only 预取 timeout/失败）→ 各源独立拉取。
        data["northbound"] = _fetch_northbound()
        data["sector_fund_flow"] = _fetch_sector_fund_flow()
        data["hot_stocks"] = _fetch_hot_stocks(date)
    data["dragon_tiger"] = _fetch_dragon_tiger(code, date)
    # 5-dimension quality scoring of dragon-tiger appearances (None when no
    # appearances — downstream should treat absence as "no signal", not an error).
    data["dragon_tiger_score"] = _score_dragon_tiger(data.get("dragon_tiger") or [])

    return data


def fetch_global_only(date):
    """Fetch only global (non-ticker-specific) hot money sources.

    Returns dict with northbound/sector_fund_flow/hot_stocks for injection
    into per-stock calls via --global-data.

    Note: 个股 fund_flow 已移除——同花顺"个股资金流"页面只收深市 ~1400 只活跃股，
    沪市几乎不收录，覆盖率天花板过低，对调仓决策信号价值有限。
    全局的 northbound/sector_fund_flow/hot_stocks 不受影响（全市场覆盖）。
    """
    return {
        "northbound": _fetch_northbound(),
        "sector_fund_flow": _fetch_sector_fund_flow(),
        "hot_stocks": _fetch_hot_stocks(date),
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch hot money data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code")
    parser.add_argument("--date", required=True, help="Analysis date YYYY-MM-DD")
    parser.add_argument("--global-only", action="store_true",
                        help="Only fetch global sources (northbound/sector_fund_flow/hot_stocks)")
    parser.add_argument("--global-data", nargs="?", const="__stdin__", default=None,
                        help="Pre-fetched global data JSON. Pass --global-data without value "
                             "to read from stdin (large payloads >32KB must use stdin on Windows).")
    args = parser.parse_args()

    try:
        if args.global_only:
            data = fetch_global_only(args.date)
            output_json(True, data=data, source="eastmoney+10jqka+hexin")
            return

        global_data = None
        if args.global_data:
            try:
                if args.global_data == "__stdin__":
                    # Read large global JSON from stdin (Windows cmdline 32KB limit).
                    raw = sys.stdin.read()
                else:
                    raw = args.global_data
                global_data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                pass

        data = fetch_hot_money(args.ticker, args.date, global_data=global_data)
        output_json(True, data=data, source="eastmoney+10jqka+hexin")
    except Exception as e:
        output_json(False, error=str(e))


if __name__ == "__main__":
    main()