"""
Tests for news.py --macro-only mode (rebalancer pipeline one-time macro fetch).

Network-free: akshare (_fetch_macro_nbs) and sina (_fetch_commodities) are patched.
Verifies that --macro-only:
  - skips per-stock news (no eastmoney/pywencai calls)
  - runs the three macro blocks (NBS indicators + sector_view + commodities)
  - outputs {macro_indicators, sector_view, commodities} structure
  - degrades gracefully when macro fetch fails
  - does not require --ticker/--date (unlike normal mode)

Also verifies the normal mode still requires --ticker/--date (argparse guard).
"""

import io
import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

news_dir = Path(__file__).parent.parent.parent / "skills" / "trading-news" / "scripts"
sys.path.insert(0, str(news_dir))

import news  # noqa: E402


# ── helpers ──────────────────────────────────────────────────────────

def run_main_capture(argv):
    """Run news.main() with patched sys.argv, capture stdout JSON.

    Returns the parsed top-level dict (output_json writes {success, data, ...}
    then calls sys.exit). Resets sys.argv after. Patches _fetch_news_eastmoney
    to assert it's NOT called in macro-only mode (proves per-stock news skipped).

    output_json (http_helpers.py) calls sys.exit(0) at the end, so we catch
    SystemExit to read the buffered stdout before the process would die."""
    news_calls = {"eastmoney": 0}

    def fake_eastmoney(code):
        news_calls["eastmoney"] += 1
        return [{"title": "x", "content": "y", "time": "2026-06-20 10:00:00", "source": "em"}]

    old_argv = sys.argv
    sys.argv = ["news.py"] + argv
    buf = io.StringIO()
    try:
        with patch("sys.stdout", buf):
            with patch.object(news, "_fetch_news_eastmoney", fake_eastmoney):
                try:
                    news.main()
                except SystemExit:
                    pass  # output_json calls sys.exit; buf already has the JSON
        out = buf.getvalue().strip()
        return json.loads(out), news_calls
    finally:
        sys.argv = old_argv


def fake_indicators():
    """Synthetic NBS indicators that produce a clear bullish view."""
    return {
        "m2_yoy": {"latest": 8.0, "label": "M2同比"},
        "manufacturing_pmi": {"latest": 52.0, "label": "制造业PMI"},
        "caixin_pmi": {"latest": 51.0, "label": "财新制造业PMI"},
        "lpr_1y": {"latest": 3.0, "label": "1年期LPR"},
        "lpr_5y": {"latest": 3.5, "label": "5年期LPR"},
        "ppi_yoy": {"latest": 1.0, "label": "PPI同比"},
    }


def fake_commodities():
    return {
        "AU0": {"label": "黄金", "latest_price": 450.0, "as_of": "2026-06-20",
                "chg_5d": 2.1, "chg_20d": 5.3, "trend": "上行"},
        "SC0": {"label": "原油", "latest_price": 620.0, "as_of": "2026-06-20",
                "chg_5d": -1.0, "chg_20d": -3.0, "trend": "下行"},
        "CU0": {"label": "铜", "latest_price": 78000.0, "as_of": "2026-06-20",
                "chg_5d": 0.5, "chg_20d": -0.5, "trend": "震荡/拐点"},
    }


# ── --macro-only happy path ──────────────────────────────────────────

class TestMacroOnlyHappy:
    def test_outputs_macro_structure(self):
        with patch.object(news, "_fetch_macro_nbs", return_value=fake_indicators()):
            with patch.object(news, "_fetch_commodities", return_value=fake_commodities()):
                out, news_calls = run_main_capture(["--macro-only", "--date", "2026-06-20"])
        assert out["success"] is True
        data = out["data"]
        assert data["ticker"] == "MACRO"
        assert data["date"] == "2026-06-20"
        # 三块宏观都输出
        assert "macro_indicators" in data
        assert "sector_view" in data
        assert "commodities" in data
        assert data["macro_indicators"]["manufacturing_pmi"]["latest"] == 52.0
        assert data["sector_view"]["market_view"] in ("震荡偏多", "结构性机会为主")
        assert data["sector_view"]["pmi_signal"] == "官方与财新PMI双口径共振向上"
        assert data["commodities"]["AU0"]["trend"] == "上行"

    def test_skips_per_stock_news(self):
        """--macro-only must NOT call eastmoney (per-stock news skipped)."""
        with patch.object(news, "_fetch_macro_nbs", return_value=fake_indicators()):
            with patch.object(news, "_fetch_commodities", return_value=fake_commodities()):
                out, news_calls = run_main_capture(["--macro-only", "--date", "2026-06-20"])
        assert news_calls["eastmoney"] == 0
        # 确认无 stock_news 字段（个股新闻块完全跳过）
        assert "stock_news" not in out["data"]

    def test_does_not_require_ticker(self):
        """--macro-only works without --ticker (macro is market-wide)."""
        with patch.object(news, "_fetch_macro_nbs", return_value=fake_indicators()):
            with patch.object(news, "_fetch_commodities", return_value=fake_commodities()):
                out, _ = run_main_capture(["--macro-only"])
        assert out["success"] is True
        assert "sector_view" in out["data"]


# ── --macro-only graceful degradation ────────────────────────────────

class TestMacroOnlyDegrade:
    def test_nbs_failure_records_error(self):
        """_fetch_macro_nbs raises → macro_indicators_error recorded, commodities still run."""
        with patch.object(news, "_fetch_macro_nbs", side_effect=Exception("akshare down")):
            with patch.object(news, "_fetch_commodities", return_value=fake_commodities()):
                out, _ = run_main_capture(["--macro-only", "--date", "2026-06-20"])
        assert out["success"] is True  # pipeline 不阻塞
        data = out["data"]
        assert data.get("macro_indicators_error") == "akshare down"
        assert "macro_indicators" not in data
        assert "commodities" in data  # 另一块不受影响

    def test_commodities_failure_records_error(self):
        with patch.object(news, "_fetch_macro_nbs", return_value=fake_indicators()):
            with patch.object(news, "_fetch_commodities", side_effect=Exception("sina down")):
                out, _ = run_main_capture(["--macro-only", "--date", "2026-06-20"])
        assert out["success"] is True
        data = out["data"]
        assert data.get("commodities_error") == "sina down"
        assert "commodities" not in data
        assert "macro_indicators" in data  # NBS 块不受影响

    def test_all_macro_empty_still_success(self):
        """Both blocks return empty → still success, just no macro fields."""
        with patch.object(news, "_fetch_macro_nbs", return_value={}):
            with patch.object(news, "_fetch_commodities", return_value={}):
                out, _ = run_main_capture(["--macro-only", "--date", "2026-06-20"])
        assert out["success"] is True
        data = out["data"]
        assert "macro_indicators" not in data
        assert "sector_view" not in data
        assert "commodities" not in data


# ── normal mode guard ────────────────────────────────────────────────

class TestNormalModeGuard:
    def test_normal_mode_requires_ticker(self):
        """Without --macro-only, --ticker/--date are required → parser.error exits."""
        # parser.error prints to stderr and calls sys.exit(2) before any stdout,
        # so run_main_capture's buf would be empty. Run main() directly and
        # assert SystemExit is raised (argparse guard fires).
        old_argv = sys.argv
        sys.argv = ["news.py"]
        try:
            with pytest.raises(SystemExit):
                news.main()
        finally:
            sys.argv = old_argv

    def test_normal_mode_still_works(self):
        """Normal mode (with ticker) still runs the fetch_news path."""
        with patch.object(news, "_fetch_news_eastmoney", return_value=[]):
            with patch.object(news, "_fetch_global_news_akshare", return_value=[]):
                with patch.object(news, "_fetch_macro_nbs", return_value={}):
                    with patch.object(news, "_fetch_commodities", return_value={}):
                        out, _ = run_main_capture(
                            ["--ticker", "SH600519", "--date", "2026-06-20", "--skip-macro"])
        assert out["success"] is True
        # normalize_ticker strips exchange prefix (SH600519 → 600519)
        assert out["data"]["ticker"] == "600519"
