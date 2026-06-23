#!/usr/bin/env python3
"""
K-line (OHLCV) data fetcher for A-share stocks.
Supports mootdx (primary) and akshare (fallback) data sources.
"""

import sys
import json
import argparse
import os
import time
from typing import Dict, Any, Optional

# Add skills/_shared to Python path for http_helpers
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../_shared"))
import http_helpers
from http_helpers import record_call, output_json


class DataFetchError(Exception):
    """Exception raised when data fetch fails from all sources."""
    pass


def detect_market(ticker: str) -> int:
    """
    Detect market from ticker code.
    Shanghai: 6xx (main board) and 68x (STAR / 科创板) both start with "6".
    Shenzhen: 0xx (main) and 3xx (ChiNext / 创业板).

    Args:
        ticker: Stock ticker code (e.g., "600519", "000001")

    Returns:
        1 for Shanghai, 0 for Shenzhen
    """
    if ticker.startswith('6'):   # 6xx main board + 68x STAR market
        return 1  # Shanghai
    elif ticker.startswith('0') or ticker.startswith('3'):
        return 0  # Shenzhen
    else:
        raise DataFetchError(f"Unknown ticker format: {ticker}")


def fetch_from_mootdx(ticker: str, count: int) -> Dict[str, Any]:
    """
    Fetch K-line data from mootdx.

    Args:
        ticker: Stock ticker code
        count: Number of data points to fetch

    Returns:
        Dictionary with OHLCV data
    """
    try:
        from mootdx.quotes import Quotes

        market = detect_market(ticker)

        # Create quotes client
        quotes = Quotes.factory(market=market, timeout=10)

        # category=9 = daily bars; mootdx expects symbol as string
        df = quotes.bars(symbol=ticker, category=9, start=0, offset=count)

        if df is None or (hasattr(df, 'empty') and df.empty):
            raise DataFetchError(f"No data returned from mootdx for {ticker}")

        # Convert to standard format
        data = {
            "ticker": ticker,
            "count": len(df),
            "data": []
        }

        for _, row in df.iterrows():
            data["data"].append({
                "date": str(row.get('datetime', '')),
                "open": float(row.get('open', 0)),
                "high": float(row.get('high', 0)),
                "low": float(row.get('low', 0)),
                "close": float(row.get('close', 0)),
                # mootdx/通达信 vol 字段单位为"手"(1 手 = 100 股)；
                # 转换为"股"以避免分析师误用 100x 过小的数值触发 Layer-2 编造误报
                "volume": float(row.get('vol', 0)) * 100,
                "amount": float(row.get('amount', 0))
            })

        return data

    except ImportError:
        raise DataFetchError("mootdx not installed")
    except Exception as e:
        raise DataFetchError(f"mootdx fetch failed: {str(e)}")


def fetch_from_akshare(ticker: str, count: int) -> Dict[str, Any]:
    """
    Fetch K-line data from akshare (fallback).

    Args:
        ticker: Stock ticker code
        count: Number of data points to fetch

    Returns:
        Dictionary with OHLCV data
    """
    try:
        import akshare as ak

        # akshare expects full ticker code with suffix
        # Shanghai: 600519 -> sh600519
        # Shenzhen: 000001 -> sz000001
        market = detect_market(ticker)
        if market == 1:
            symbol = f"sh{ticker}"
        else:
            symbol = f"sz{ticker}"

        # Fetch stock data using akshare
        df = ak.stock_zh_a_hist(symbol=symbol, period="daily",
                                start_date="19700101", adjust="qfq")

        if df is None or df.empty:
            raise DataFetchError(f"No data returned from akshare for {ticker}")

        # Take the most recent `count` records
        df = df.tail(count)

        # Convert to standard format
        data = {
            "ticker": ticker,
            "count": len(df),
            "data": []
        }

        for _, row in df.iterrows():
            data["data"].append({
                "date": str(row.get('日期', '')),
                "open": float(row.get('开盘', 0)),
                "high": float(row.get('最高', 0)),
                "low": float(row.get('最低', 0)),
                "close": float(row.get('收盘', 0)),
                # akshare stock_zh_a_hist 成交量同样以"手"为单位(遵循 TDX 协议)；转换为"股"
                "volume": float(row.get('成交量', 0)) * 100,
                "amount": float(row.get('成交额', 0))
            })

        return data

    except ImportError:
        raise DataFetchError("akshare not installed")
    except Exception as e:
        raise DataFetchError(f"akshare fetch failed: {str(e)}")


# Source priority list
SOURCES = ["mootdx", "akshare"]


# ── VPA (Volume Price Analysis) pre-computation ──────────────────

VPA_WINDOW = 20  # Base window for volume moving average


def compute_vpa(data: list) -> str:
    """
    Pre-compute Volume Price Analysis indicators from OHLCV data.
    Returns a human-readable markdown report for the LLM.
    All arithmetic is done here so the LLM only needs to interpret results.
    """
    if not data or len(data) < VPA_WINDOW + 5:
        return "VPA 数据不足：历史 K 线数量不够（需要至少 25 天）"

    rows = []
    for d in data:
        try:
            rows.append({
                "date": str(d.get("date", ""))[:10],  # YYYY-MM-DD
                "open": float(d.get("open", 0)),
                "high": float(d.get("high", 0)),
                "low": float(d.get("low", 0)),
                "close": float(d.get("close", 0)),
                "volume": float(d.get("volume", 0)),
            })
        except (ValueError, TypeError):
            continue

    if len(rows) < VPA_WINDOW + 5:
        return "VPA 数据不足：有效 K 线数量不够"

    n = len(rows)

    # ── Derived indicators ──
    for i, r in enumerate(rows):
        vol_window = rows[max(0, i - VPA_WINDOW):i + 1]
        vol_ma = sum(x["volume"] for x in vol_window) / len(vol_window) if vol_window else 1
        r["vol_ma"] = vol_ma
        r["volume_ratio"] = r["volume"] / vol_ma if vol_ma > 0 else 0

        hl_range = r["high"] - r["low"]
        r["bar_spread"] = hl_range / r["close"] if r["close"] > 0 else 0
        r["close_position"] = (
            (r["close"] - r["low"]) / hl_range if hl_range > 0 else 0.5
        )
        r["bar_type"] = (
            "阳线" if r["close"] > r["open"]
            else "阴线" if r["close"] < r["open"]
            else "十字星"
        )
        r["upper_shadow"] = (
            (r["high"] - max(r["open"], r["close"])) / hl_range if hl_range > 0 else 0.0
        )
        r["lower_shadow"] = (
            (min(r["open"], r["close"]) - r["low"]) / hl_range if hl_range > 0 else 0.0
        )

        if i > 0:
            prev_close = rows[i - 1]["close"]
            r["pct_change"] = (r["close"] - prev_close) / prev_close if prev_close > 0 else 0
        else:
            r["pct_change"] = 0

        # Volume-price harmony
        if r["pct_change"] > 0.005 and r["volume_ratio"] > 1.0:
            r["vp_harmony"] = "一致(涨+放量)"
        elif r["pct_change"] < -0.005 and r["volume_ratio"] > 1.0:
            r["vp_harmony"] = "一致(跌+放量)"
        elif r["pct_change"] > 0.005 and r["volume_ratio"] < 0.8:
            r["vp_harmony"] = "背离(涨+缩量)"
        elif r["pct_change"] < -0.005 and r["volume_ratio"] < 0.8:
            r["vp_harmony"] = "背离(跌+缩量)"
        else:
            r["vp_harmony"] = "中性"

    # ── OBV trend ──
    obv = 0
    obv_values = [0]
    for i in range(1, n):
        if rows[i]["close"] > rows[i - 1]["close"]:
            obv += rows[i]["volume"]
        elif rows[i]["close"] < rows[i - 1]["close"]:
            obv -= rows[i]["volume"]
        obv_values.append(obv)

    obv_tail = obv_values[-10:] if len(obv_values) >= 10 else obv_values
    obv_trend = "上升" if len(obv_tail) >= 2 and obv_tail[-1] > obv_tail[0] else "下降"

    # ── Volume trend (5d vs 20d) ──
    last = rows[-1]
    vol_5d = sum(r["volume"] for r in rows[-5:]) / 5
    vol_20d = last["vol_ma"] if last["vol_ma"] > 0 else 1
    vol_trend_ratio = vol_5d / vol_20d if vol_20d > 0 else 1
    vol_summary = (
        "放量" if vol_trend_ratio > 1.2
        else "缩量" if vol_trend_ratio < 0.8
        else "平稳"
    )

    # ── Build output ──

    # Recent key stats block — pre-computed numbers the LLM must cite verbatim.
    # Regression: 688662 market report self-computed pct_change from raw bars
    # and got every recent day wrong (+13.6%/+22.4%/+15.1% reported vs actual
    # +20.0%/+14.0%/+17.8%). The VPA per-day table already had the right
    # numbers, but the LLM either misread the 30-row table or recomputed
    # from `close` with the wrong baseline. Putting the headline numbers up
    # front with an explicit "do not recompute" warning closes the gap.
    def _fmt_pct(frac: float) -> str:
        return f"{frac * 100:+.1f}%"

    last = rows[-1]
    recent_block: list[str] = [
        "### 近期关键行情摘要（预计算，直接引用）\n",
        "> **禁止自行计算涨跌幅** —— 以下数值已由系统基于完整 K 线预计算，直接引用即可。",
        "> 从 raw K 线自行计算极易出错（前收盘基准 / 累计口径 / 日期对齐不一致）。\n",
        f"- **最新收盘价**: {last['close']:.2f} 元（{last['date']}）",
        f"- **当日涨跌幅**: {_fmt_pct(last['pct_change'])}",
    ]
    # Per-day pct for the last 3 trading days (oldest → newest)
    if len(rows) >= 3:
        per_day = [rows[-3]["pct_change"], rows[-2]["pct_change"], rows[-1]["pct_change"]]
        recent_block.append(
            f"- **近3日逐日涨跌幅（旧→新）**: {' / '.join(_fmt_pct(p) for p in per_day)}"
        )

    def _push_cumulative(days: int) -> None:
        if len(rows) <= days:
            recent_block.append(f"- **近{days}日累计涨跌幅**: 数据不足（K 线仅 {len(rows)} 根）")
            return
        prev_close = rows[-days - 1]["close"]
        cur_close = rows[-1]["close"]
        if prev_close > 0:
            cum = (cur_close - prev_close) / prev_close
            recent_block.append(
                f"- **近{days}日累计涨跌幅**: {_fmt_pct(cum)}"
                f"（从 {prev_close:.2f} 元至 {cur_close:.2f} 元）"
            )

    for _days in (5, 10, 30):
        _push_cumulative(_days)
    recent_block.append("")  # trailing blank line for markdown spacing

    lines = [
        f"## VPA 量价预计算指标（基于 {VPA_WINDOW} 日均量基准）\n",
        *recent_block,
        f"**OBV 趋势（10日）**: {obv_trend}",
        f"**近5日量能趋势**: {vol_summary}（5日均量/20日均量 = {vol_trend_ratio:.2f}）\n",
        "### 逐日量价数据\n",
        "| 日期 | 类型 | 涨跌幅 | 实体大小 | 收盘位置 | 上影线 | 下影线 | 量比 | 量价关系 |",
        "|------|------|--------|----------|----------|--------|--------|------|----------|",
    ]

    # Show last 30 days
    display_rows = rows[-30:] if len(rows) > 30 else rows
    for r in display_rows:
        pct = r["pct_change"] * 100
        spread_label = "宽" if r["bar_spread"] > 0.03 else ("窄" if r["bar_spread"] < 0.015 else "中")
        cp = r["close_position"]
        cp_label = "高位" if cp > 0.7 else ("低位" if cp < 0.3 else "中位")

        vr = r["volume_ratio"]
        vr_label = f"{vr:.1f}"
        if vr > 2.0:
            vr_label += "(巨量)"
        elif vr > 1.5:
            vr_label += "(明显放量)"
        elif vr > 1.0:
            vr_label += "(温和放量)"
        elif vr < 0.5:
            vr_label += "(极度缩量)"
        elif vr < 0.8:
            vr_label += "(缩量)"

        lines.append(
            f"| {r['date']} | {r['bar_type']} | {pct:+.1f}% "
            f"| {spread_label}({r['bar_spread']:.3f}) "
            f"| {cp_label}({cp:.2f}) | {r['upper_shadow']:.2f} "
            f"| {r['lower_shadow']:.2f} | {vr_label} | {r['vp_harmony']} |"
        )

    # ── Pattern recognition ──
    lines.append("\n### 关键量价模式识别\n")
    last5 = rows[-5:]
    price_up = last5[-1]["close"] > last5[0]["close"]
    vol_down = last5[-1]["volume"] < last5[0]["volume"]
    price_down = last5[-1]["close"] < last5[0]["close"]
    vol_up = last5[-1]["volume"] > last5[0]["volume"]

    found_pattern = False
    if price_up and vol_down:
        lines.append("- **顶部背离信号**: 近5日价格上涨但成交量递减，上涨动能可能衰竭")
        found_pattern = True
    if price_down and vol_up:
        lines.append("- **底部放量信号**: 近5日价格下跌但成交量递增，可能是恐慌抛售或换手")
        found_pattern = True
    if price_down and vol_down:
        lines.append("- **卖压衰竭信号**: 近5日价格下跌且成交量递减，空方力量可能枯竭")
        found_pattern = True
    if price_up and vol_up:
        lines.append("- **健康上涨信号**: 近5日价格上涨且成交量配合递增")
        found_pattern = True

    # Selling climax / 放量滞涨 in last 3 days
    for r in rows[-3:]:
        if r["volume_ratio"] > 2.0 and r["pct_change"] < -0.03 and r["close_position"] > 0.5:
            lines.append(
                f"- **卖出高潮(Selling Climax)**: {r['date']} 急跌巨量但收盘收回过半，可能是恐慌见底"
            )
            found_pattern = True
        if r["volume_ratio"] > 1.8 and abs(r["pct_change"]) < 0.01 and r["bar_spread"] < 0.015:
            lines.append(
                f"- **放量滞涨**: {r['date']} 巨量但价格几乎不动（窄实体），多空分歧大"
            )
            found_pattern = True

    if not found_pattern:
        lines.append("- 近期无显著量价异常模式")

    return "\n".join(lines)


# ── MACD structured output ────────────────────────────────────

def compute_macd(data_or_closes):
    """Compute MACD (12, 26, 9) and return structured dict for TypeScript consumption.

    Accepts either a list of close prices or a list of bar dicts (with 'close' key).
    Returns dict with dif, dea, histogram, direction, crossover — or None if data insufficient.
    """
    if not data_or_closes:
        return None
    if isinstance(data_or_closes[0], dict):
        closes = [b.get("close", 0) for b in data_or_closes if isinstance(b.get("close"), (int, float))]
    else:
        closes = [c for c in data_or_closes if isinstance(c, (int, float))]
    if len(closes) < 36:  # need 26 for EMA26 + 9 for DEA + 1 margin
        return None

    def _ema_series(arr, period):
        k = 2.0 / (period + 1)
        series = [sum(arr[:period]) / period]
        for price in arr[period:]:
            series.append(price * k + series[-1] * (1 - k))
        return series

    ema12 = _ema_series(closes, 12)
    ema26 = _ema_series(closes, 26)
    if len(ema12) < len(ema26) or len(ema26) < 10:
        return None

    offset = len(ema12) - len(ema26)
    dif_series = [ema12[i + offset] - ema26[i] for i in range(len(ema26))]
    dea_series = _ema_series(dif_series, 9) if len(dif_series) >= 9 else []
    if not dif_series or not dea_series:
        return None

    dif = round(dif_series[-1], 4)
    dea = round(dea_series[-1], 4)
    histogram = round(2 * (dif - dea), 4)
    direction = "看多" if dif > dea else "看空" if dif < dea else "中性"

    crossover = "none"
    if len(dif_series) >= 2 and len(dea_series) >= 2:
        prev_dif, prev_dea = dif_series[-2], dea_series[-2]
        if prev_dif <= prev_dea and dif > dea:
            crossover = "golden"
        elif prev_dif >= prev_dea and dif < dea:
            crossover = "death"

    return {"dif": dif, "dea": dea, "histogram": histogram,
            "direction": direction, "crossover": crossover}


# ── Technical Indicators pre-computation ────────────────────────

def compute_technical_indicators(data: list) -> str:
    """
    Pre-compute common technical indicators from OHLCV data.
    Returns a human-readable markdown report for the LLM.
    """
    if not data or len(data) < 50:
        return "技术指标数据不足：历史 K 线数量不够（需要至少 50 天）"

    rows = []
    for d in data:
        try:
            rows.append({
                "date": str(d.get("date", ""))[:10],  # YYYY-MM-DD
                "close": float(d.get("close", 0)),
                "high": float(d.get("high", 0)),
                "low": float(d.get("low", 0)),
                "open": float(d.get("open", 0)),
                "volume": float(d.get("volume", 0)),
            })
        except (ValueError, TypeError):
            continue

    if len(rows) < 50:
        return "技术指标数据不足：有效 K 线数量不够"

    n = len(rows)
    closes = [r["close"] for r in rows]
    highs = [r["high"] for r in rows]
    lows = [r["low"] for r in rows]
    volumes = [r["volume"] for r in rows]

    lines = ["## 预计算技术指标\n"]

    # ── SMA (5/10/20/50/200) ──
    def sma(arr, period):
        if len(arr) < period:
            return None
        return sum(arr[-period:]) / period

    sma5 = sma(closes, 5)
    sma10 = sma(closes, 10)
    sma20 = sma(closes, 20)
    sma50 = sma(closes, 50)
    sma200 = sma(closes, 200)

    lines.append("### 移动平均线 (SMA)")
    lines.append(f"- SMA5: {sma5:.2f}" if sma5 else "- SMA5: 数据不足")
    lines.append(f"- SMA10: {sma10:.2f}" if sma10 else "- SMA10: 数据不足")
    lines.append(f"- SMA20: {sma20:.2f}" if sma20 else "- SMA20: 数据不足")
    lines.append(f"- SMA50: {sma50:.2f}" if sma50 else "- SMA50: 数据不足")
    lines.append(f"- SMA200: {sma200:.2f}" if sma200 else "- SMA200: 数据不足")

    last_close = closes[-1]
    # Determine alignment
    sma_vals = [v for v in [sma5, sma10, sma20, sma50] if v is not None]
    if sma_vals:
        if all(last_close > v for v in sma_vals):
            lines.append(f"- **均线排列**: 多头排列（价格 {last_close:.2f} 在所有短期均线之上）")
        elif all(last_close < v for v in sma_vals):
            lines.append(f"- **均线排列**: 空头排列（价格 {last_close:.2f} 在所有短期均线之下）")
        else:
            lines.append(f"- **均线排列**: 交织排列（价格与均线关系不一致）")

    # SMA crossover signals (5/10 short-term)
    if sma5 and sma10 and n >= 2:
        prev_sma5 = sum(closes[-6:-1]) / 5
        prev_sma10 = sum(closes[-11:-1]) / 10
        if prev_sma5 <= prev_sma10 and sma5 > sma10:
            lines.append("- **金叉信号**: SMA5 上穿 SMA10（短期看多）")
        elif prev_sma5 >= prev_sma10 and sma5 < sma10:
            lines.append("- **死叉信号**: SMA5 下穿 SMA10（短期看空）")

    lines.append("")

    # ── MACD (12, 26, 9) ──
    macd_data = compute_macd(closes)
    if macd_data:
        dif, dea, macd_hist = macd_data["dif"], macd_data["dea"], macd_data["histogram"]
        lines.append("### MACD (12, 26, 9)")
        lines.append(f"- DIF (快线): {dif:.4f}")
        lines.append(f"- DEA (慢线): {dea:.4f}")
        lines.append(f"- MACD 柱状图: {macd_hist:.4f}")

        crossover = macd_data["crossover"]
        direction = macd_data["direction"]
        if crossover == "golden":
            lines.append("- **金叉信号**: DIF 上穿 DEA（看多）")
        elif crossover == "death":
            lines.append("- **死叉信号**: DIF 下穿 DEA（看空）")
        elif direction == "看多":
            lines.append("- MACD 多头运行（DIF > DEA，柱状图为正）")
        elif direction == "看空":
            lines.append("- MACD 空头运行（DIF < DEA，柱状图为负）")
        lines.append("")

    # ── RSI (14) ──
    rsi = None
    period = 14
    if len(closes) >= period + 1:
        gains = []
        losses = []
        for i in range(1, len(closes)):
            change = closes[i] - closes[i - 1]
            gains.append(max(0, change))
            losses.append(max(0, -change))

        avg_gain = sum(gains[-period:]) / period
        avg_loss = sum(losses[-period:]) / period

        if avg_loss == 0:
            rsi = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi = 100.0 - (100.0 / (1.0 + rs))

        lines.append("### RSI (14)")
        lines.append(f"- RSI: {rsi:.2f}")
        if rsi > 70:
            lines.append("- **超买区域** (>70)：可能面临回调压力")
        elif rsi > 60:
            lines.append("- 偏强区域 (60-70)：多头占优")
        elif rsi < 30:
            lines.append("- **超卖区域** (<30)：可能出现技术反弹")
        elif rsi < 40:
            lines.append("- 偏弱区域 (30-40)：空头占优")
        else:
            lines.append("- 中性区域 (40-60)：多空均衡")
        lines.append("")

    # ── KDJ (9, 3, 3) ──
    k_val = d_val = j_val = None
    kdj_period = 9
    if n >= kdj_period:
        k_values = [50.0]  # Start at 50
        d_values = [50.0]

        for i in range(kdj_period - 1, n):
            high_n = max(highs[i - kdj_period + 1:i + 1])
            low_n = min(lows[i - kdj_period + 1:i + 1])
            diff_hl = high_n - low_n
            if diff_hl == 0:
                rsv = 50.0
            else:
                rsv = (closes[i] - low_n) / diff_hl * 100.0
            k = 2.0 / 3.0 * k_values[-1] + 1.0 / 3.0 * rsv
            d = 2.0 / 3.0 * d_values[-1] + 1.0 / 3.0 * k
            k_values.append(k)
            d_values.append(d)

        k_val = k_values[-1]
        d_val = d_values[-1]
        j_val = 3 * k_val - 2 * d_val

        lines.append("### KDJ (9, 3, 3)")
        lines.append(f"- K: {k_val:.2f}")
        lines.append(f"- D: {d_val:.2f}")
        lines.append(f"- J: {j_val:.2f}")

        if len(k_values) >= 2:
            prev_k = k_values[-2]
            prev_d = d_values[-2]
            if prev_k <= prev_d and k_val > d_val:
                lines.append("- **金叉信号**: K 上穿 D（看多）")
            elif prev_k >= prev_d and k_val < d_val:
                lines.append("- **死叉信号**: K 下穿 D（看空）")

        if j_val > 100:
            lines.append("- J 值超过 100，超买警告")
        elif j_val < 0:
            lines.append("- J 值低于 0，超卖警告")
        lines.append("")

    # ── Bollinger Bands (20, 2) ──
    boll_ma = band_width = position = None
    boll_period = 20
    if n >= boll_period:
        boll_ma = sum(closes[-boll_period:]) / boll_period
        variance = sum((c - boll_ma) ** 2 for c in closes[-boll_period:]) / boll_period
        std_dev = variance ** 0.5
        upper = boll_ma + 2 * std_dev
        lower = boll_ma - 2 * std_dev

        lines.append("### 布林带 (20, 2)")
        lines.append(f"- 上轨: {upper:.2f}")
        lines.append(f"- 中轨: {boll_ma:.2f}")
        lines.append(f"- 下轨: {lower:.2f}")
        lines.append(f"- 当前价格: {last_close:.2f}")

        band_width = upper - lower
        if band_width > 0:
            position = (last_close - lower) / band_width
            lines.append(f"- 价格位置: {position:.1%}（0%=下轨，100%=上轨）")
            if position > 0.9:
                lines.append("- **接近上轨**：短期超买，可能回调")
            elif position < 0.1:
                lines.append("- **接近下轨**：短期超卖，可能反弹")
            elif position > 0.5:
                lines.append("- 偏向上轨运行")
            else:
                lines.append("- 偏向下轨运行")
        lines.append("")

    # ── Summary signal table ──
    lines.append("### 综合信号汇总")
    lines.append("")
    lines.append("| 指标 | 数值 | 信号方向 | 信号强度 |")
    lines.append("|------|------|----------|----------|")

    signals = []

    # SMA signal
    if sma_vals:
        sma_dir = "看多" if all(last_close > v for v in sma_vals) else "看空" if all(last_close < v for v in sma_vals) else "中性"
        sma_strength = "强" if sma_dir != "中性" else "弱"
        signals.append(("SMA 排列", f"价={last_close:.2f}", sma_dir, sma_strength))

    # MACD signal
    if dif_series and dea_series:
        macd_dir = "看多" if dif > dea else "看空"
        macd_str = "强" if abs(macd_hist) > abs(dif) * 0.3 else "中"
        signals.append(("MACD", f"DIF={dif:.3f}", macd_dir, macd_str))

    # RSI signal
    if rsi is not None:
        rsi_dir = "看多" if rsi > 60 else "看空" if rsi < 40 else "中性"
        rsi_str = "强" if rsi > 70 or rsi < 30 else "中"
        signals.append(("RSI(14)", f"{rsi:.1f}", rsi_dir, rsi_str))

    # KDJ signal
    if k_val is not None:
        kdj_dir = "看多" if k_val > d_val else "看空"
        kdj_str = "强" if j_val > 100 or j_val < 0 else "中"
        signals.append(("KDJ", f"K={k_val:.1f} D={d_val:.1f}", kdj_dir, kdj_str))

    # Bollinger signal
    if boll_ma is not None and band_width > 0:
        boll_dir = "看多" if position < 0.2 else "看空" if position > 0.8 else "中性"
        boll_str = "强" if position < 0.1 or position > 0.9 else "中"
        signals.append(("Bollinger", f"位={position:.0%}", boll_dir, boll_str))

    for name, val, direction, strength in signals:
        lines.append(f"| {name} | {val} | {direction} | {strength} |")

    bull_count = sum(1 for s in signals if s[2] == "看多")
    bear_count = sum(1 for s in signals if s[2] == "看空")
    lines.append(f"\n**多头信号**: {bull_count} | **空头信号**: {bear_count} | **中性**: {len(signals) - bull_count - bear_count}")

    return "\n".join(lines)


def fetch(ticker: str, count: int = 120) -> Dict[str, Any]:
    """
    Fetch K-line data with automatic fallback.

    Args:
        ticker: Stock ticker code (支持 SH600183 / 600183.SH / 600183 等格式，
                入口归一化为纯 6 位数字，与 fundamentals.py/hot_money.py 对齐)
        count: Number of data points to fetch (default: 60)

    Returns:
        Dictionary with success status and data/error info
    """
    # 归一化 ticker：剥离 SH/SZ/BJ 前缀或 .SH/.SZ 后缀。
    # 老实现直接把 ticker 传给 detect_market，后者只认纯数字（startswith('6')），
    # 导致 "SH600183" → Unknown ticker format。rebalance 传的就是带前缀格式。
    ticker = http_helpers.normalize_ticker(ticker)
    last_error = None

    for source in SOURCES:
        start = time.monotonic()
        try:
            if source == "mootdx":
                data = fetch_from_mootdx(ticker, count)
            elif source == "akshare":
                data = fetch_from_akshare(ticker, count)
            else:
                continue

            # Record successful fetch from this source
            record_call(f"kline/{source}", success=True,
                        duration_ms=(time.monotonic() - start) * 1000)

            # Pre-compute VPA indicators
            try:
                vpa_report = compute_vpa(data.get("data", []))
            except Exception:
                vpa_report = "VPA 计算失败"

            # Pre-compute technical indicators
            try:
                ti_report = compute_technical_indicators(data.get("data", []))
            except Exception:
                ti_report = "技术指标计算失败"

            # Pre-compute MACD structured data (for TypeScript extraction)
            try:
                macd_structured = compute_macd(data.get("data", []))
            except Exception:
                macd_structured = None

            return {
                "success": True,
                "data": data,
                "vpa": vpa_report,
                "technical_indicators": ti_report,
                "macd": macd_structured,
                "_source": source
            }
        except DataFetchError as e:
            record_call(f"kline/{source}", success=False, error=str(e),
                        duration_ms=(time.monotonic() - start) * 1000)
            last_error = str(e)
            continue
        except Exception as e:
            record_call(f"kline/{source}", success=False, error=str(e),
                        duration_ms=(time.monotonic() - start) * 1000)
            last_error = str(e)
            continue

    # All sources failed
    return {
        "success": False,
        "error": last_error or "All data sources failed"
    }


def parse_stdin() -> Optional[Dict[str, Any]]:
    """
    Parse JSON input from stdin.

    Returns:
        Parsed dictionary or None if no stdin input
    """
    try:
        if not sys.stdin.isatty():
            stdin_data = sys.stdin.read().strip()
            if stdin_data:
                return json.loads(stdin_data)
    except Exception:
        pass
    return None


def main():
    """Main entry point for CLI usage."""
    # Windows console defaults to GBK; force UTF-8 so json.dumps output
    # containing any non-GBK char (rare Han, symbols, etc.) doesn't crash
    # print(). Python 3.7+ supports reconfigure on stdout.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass  # fallback: legacy Python or unsupported stream

    parser = argparse.ArgumentParser(description="Fetch K-line data for A-share stocks")
    parser.add_argument("--ticker", required=True, help="Stock ticker code (e.g., 600519)")
    parser.add_argument("--date", default="", help="Analysis date YYYY-MM-DD (unused by kline)")
    parser.add_argument("--count", type=int, default=120, help="Number of data points (default: 120)")

    # Try to parse from stdin first
    stdin_input = parse_stdin()
    if stdin_input:
        ticker = stdin_input.get("ticker")
        count = stdin_input.get("count", 120)
        if ticker:
            result = fetch(ticker, count)
            # Attach per-source call records so downstream (exec-python) can observe them
            result["_calls"] = http_helpers.get_calls()
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(0 if result["success"] else 1)

    # Parse command line arguments
    args = parser.parse_args()
    result = fetch(args.ticker, args.count)
    # Attach per-source call records so downstream (exec-python) can observe them
    result["_calls"] = http_helpers.get_calls()
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()
