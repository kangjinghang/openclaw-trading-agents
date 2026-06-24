"""
Tests for _build_macro_sector_view + _fetch_commodities in news.py.

No network calls — pure rule engine tests on synthetic data, and commodity
fetch tests with http_get patched (jsonp parsing + trend derivation).
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

news_dir = Path(__file__).parent.parent.parent / "skills" / "trading-news" / "scripts"
sys.path.insert(0, str(news_dir))

from news import _build_macro_sector_view, _fetch_commodities, _price_change_pct  # noqa: E402


class TestBuildMacroSectorView:
    """Test rule-based macro → sector mapping engine."""

    def test_bullish_when_strong_macro(self):
        """Strong M2 + PMI > 50 + low LPR → bullish."""
        indicators = {
            "m2_yoy": {"latest": 8.0},
            "manufacturing_pmi": {"latest": 52.0},
            "lpr_1y": {"latest": 3.0},
            "lpr_5y": {"latest": 3.5},
            "ppi_yoy": {"latest": 1.0},
        }
        result = _build_macro_sector_view(indicators)
        assert result["total_score"] > 0
        assert result["market_view"] in ("震荡偏多", "结构性机会为主")
        assert len(result["bullish_sectors"]) > 0

    def test_bearish_when_weak_macro(self):
        """Weak PMI < 50 + PPI < 0 → bearish."""
        indicators = {
            "manufacturing_pmi": {"latest": 48.0},
            "ppi_yoy": {"latest": -2.0},
            "m2_yoy": {"latest": 4.0},
        }
        result = _build_macro_sector_view(indicators)
        assert result["total_score"] < 0
        assert len(result["bearish_sectors"]) > 0

    def test_lpr_boosts_sectors(self):
        """Low LPR should boost 银行/券商/保险/房地产."""
        indicators = {
            "lpr_1y": {"latest": 3.0},
            "lpr_5y": {"latest": 3.5},
        }
        result = _build_macro_sector_view(indicators)
        assert "银行" in result["bullish_sectors"]
        assert "券商" in result["bullish_sectors"]
        assert "保险" in result["bullish_sectors"]
        assert "房地产" in result["bullish_sectors"]

    def test_pmi_cyclical_boost(self):
        """PMI > 50 should boost 周期/科技 sectors."""
        indicators = {
            "manufacturing_pmi": {"latest": 51.5},
        }
        result = _build_macro_sector_view(indicators)
        assert "半导体" in result["bullish_sectors"]

    def test_empty_indicators_neutral(self):
        """No indicators → neutral view."""
        result = _build_macro_sector_view({})
        assert result["total_score"] == 0
        assert result["market_view"] == "结构性机会为主"
        assert result["bullish_sectors"] == []
        assert result["bearish_sectors"] == []

    def test_none_latest_ignored(self):
        """Indicators with None latest should be skipped."""
        indicators = {
            "manufacturing_pmi": {"latest": None},
            "m2_yoy": {"latest": 7.0},
        }
        result = _build_macro_sector_view(indicators)
        assert "manufacturing_pmi" not in result["indicators_used"]
        assert "m2_yoy" in result["indicators_used"]

    def test_sector_scores_included(self):
        """Top 10 sector scores should be included."""
        indicators = {
            "m2_yoy": {"latest": 7.0},
            "manufacturing_pmi": {"latest": 51.0},
        }
        result = _build_macro_sector_view(indicators)
        assert "sector_scores" in result
        assert len(result["sector_scores"]) <= 10

    def test_indicators_used_list(self):
        """indicators_used should list which indicators had values."""
        indicators = {
            "m2_yoy": {"latest": 7.0},
            "cpi_yoy": {"latest": 0.5},
            "ppi_yoy": {"latest": -1.0},
        }
        result = _build_macro_sector_view(indicators)
        assert set(result["indicators_used"]) == {"m2_yoy", "cpi_yoy", "ppi_yoy"}


# ── 财新PMI 双口径（caixin_pmi）──────────────────────────────────────

class TestCaixinPmiDualGauge:
    """官方PMI 与财新PMI 双口径共振/背离检测。"""

    def test_caixin_pmi_boosts_cyclical_sectors(self):
        """财新PMI ≥50 给制造业/周期板块额外加分。

        半导体规则: manufacturing_pmi≥50(+2) + manufacturing_pmi 无条件(-1) +
        caixin_pmi≥50(+1) = +2。有财新PMI 比无财新PMI（仅+2-1=+1）多 1 分。
        """
        indicators = {
            "manufacturing_pmi": {"latest": 51.0},
            "caixin_pmi": {"latest": 51.0},
        }
        result = _build_macro_sector_view(indicators)
        assert result["sector_scores"]["半导体"] == 2

        # 对比：无财新PMI 时半导体只有 +2-1 = +1，证明财新PMI 贡献了 +1
        no_cx = _build_macro_sector_view({"manufacturing_pmi": {"latest": 51.0}})
        assert no_cx["sector_scores"]["半导体"] == 1

    def test_pmi_signal_resonance_up(self):
        """官方与财新PMI 双≥50 → 共振向上信号 + growth_signals +1。"""
        indicators = {
            "manufacturing_pmi": {"latest": 51.0},
            "caixin_pmi": {"latest": 52.0},
        }
        result = _build_macro_sector_view(indicators)
        assert "共振向上" in result["pmi_signal"]

    def test_pmi_signal_resonance_down(self):
        """官方与财新PMI 双<50 → 共振向下信号。"""
        indicators = {
            "manufacturing_pmi": {"latest": 49.0},
            "caixin_pmi": {"latest": 48.5},
        }
        result = _build_macro_sector_view(indicators)
        assert "共振向下" in result["pmi_signal"]
        assert result["market_view"] == "震荡偏谨慎"

    def test_pmi_signal_divergence(self):
        """官方≥50 但财新<50（或反之）→ 分化信号，倾向结构性机会。"""
        indicators = {
            "manufacturing_pmi": {"latest": 51.0},
            "caixin_pmi": {"latest": 49.0},
        }
        result = _build_macro_sector_view(indicators)
        assert "分化" in result["pmi_signal"]
        # 分化时 market_view 倾向结构性机会（不单边偏多）
        assert result["market_view"] != "震荡偏多"

    def test_no_pmi_signal_when_only_one_gauge(self):
        """只有官方PMI、无财新PMI 时不输出 pmi_signal。"""
        indicators = {"manufacturing_pmi": {"latest": 51.0}}
        result = _build_macro_sector_view(indicators)
        assert "pmi_signal" not in result

    def test_no_pmi_signal_when_neither_gauge(self):
        """两个PMI 都缺时不输出 pmi_signal。"""
        result = _build_macro_sector_view({"m2_yoy": {"latest": 7.0}})
        assert "pmi_signal" not in result


# ── 大宗商品 _fetch_commodities ─────────────────────────────────────

def _sina_resp(symbol, bars):
    """Build a mocked sina futures jsonp response body."""
    import json
    payload = [{"d": d, "o": p, "h": p, "l": p, "c": p, "v": 100, "p": 200, "s": 0}
               for d, p in bars]
    return (f"/*<script>location.href='//sina.com';</script>*/"
            f"var _{symbol}2021_08_17=({json.dumps(payload)});")


class TestPriceChangePct:
    def test_normal(self):
        # 100 → 105 over 5 days = +5%
        closes = [100, 101, 102, 103, 104, 105]
        assert _price_change_pct(closes, 5) == 5.0

    def test_too_short(self):
        assert _price_change_pct([100, 101], 5) is None

    def test_negative(self):
        closes = [100, 99, 98, 97, 96, 95]
        assert _price_change_pct(closes, 5) == -5.0


class TestFetchCommodities:
    def test_parses_all_three_with_trend(self):
        """正常解析金/油/铜，含趋势判定。"""
        # 25 根K线，末 5 根持续上涨 → chg_5d 正；整体末 20 根微涨 → chg_20d 正
        rising = [("2026-05-01", 100 + i) for i in range(25)]
        def fake_get(url, **kwargs):
            for sym in ("AU0", "SC0", "CU0"):
                if sym in url:
                    return MagicMock(text=_sina_resp(sym, rising))
            return MagicMock(text="")
        with patch("news.http_get", side_effect=fake_get):
            result = _fetch_commodities()
        assert set(result.keys()) == {"AU0", "SC0", "CU0"}
        gold = result["AU0"]
        assert gold["label"] == "黄金"
        assert gold["latest_price"] == 124
        assert gold["chg_5d"] > 0
        assert gold["trend"] == "上行"

    def test_trend_down_when_falling(self):
        falling = [("2026-05-01", 200 - i) for i in range(25)]
        def fake_get(url, **kwargs):
            for sym in ("AU0", "SC0", "CU0"):
                if sym in url:
                    return MagicMock(text=_sina_resp(sym, falling))
            return MagicMock(text="")
        with patch("news.http_get", side_effect=fake_get):
            result = _fetch_commodities()
        assert result["AU0"]["trend"] == "下行"
        assert result["AU0"]["chg_5d"] < 0

    def test_trend_zigzag_when_5d_up_20d_down(self):
        # 近5日涨、近20日跌 → 震荡/拐点
        prices = [200] * 15 + [180, 175, 170, 168, 165] + [165, 166, 168, 170, 172]
        bars = [(f"2026-05-{i+1:02d}", p) for i, p in enumerate(prices)]
        def fake_get(url, **kwargs):
            for sym in ("AU0",):
                if sym in url:
                    return MagicMock(text=_sina_resp(sym, bars))
            return MagicMock(text="")
        with patch("news.http_get", side_effect=fake_get):
            result = _fetch_commodities()
        assert result["AU0"]["trend"] == "震荡/拐点"

    def test_graceful_degrade_on_parse_failure(self):
        """jsonp 解析失败 → 该品种跳过，不影响其他。"""
        def fake_get(url, **kwargs):
            if "AU0" in url:
                return MagicMock(text="garbage not jsonp")
            return MagicMock(text=_sina_resp("SC0", [("2026-06-01", 400)]))
        with patch("news.http_get", side_effect=fake_get):
            result = _fetch_commodities()
        assert "AU0" not in result       # 解析失败跳过
        assert "SC0" in result           # 其他正常

    def test_http_error_skips_symbol(self):
        """HTTP 异常 → 该品种跳过，不抛错。"""
        def fake_get(url, **kwargs):
            raise Exception("connection reset")
        with patch("news.http_get", side_effect=fake_get):
            result = _fetch_commodities()
        assert result == {}

    def test_empty_kline_skipped(self):
        def fake_get(url, **kwargs):
            for sym in ("AU0",):
                if sym in url:
                    return MagicMock(text=_sina_resp(sym, []))
            return MagicMock(text="")
        with patch("news.http_get", side_effect=fake_get):
            result = _fetch_commodities()
        assert result == {}
