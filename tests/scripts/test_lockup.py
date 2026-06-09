"""
Tests for trading-lockup skill — the announcement-events additions
(_classify_announcement + _fetch_announcements).

Network-free: http_get is patched. Verifies classification, importance scoring,
lockup-expiry filtering, lookback window, top-N cap, URL build, and graceful
degradation on API failure.
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "trading-lockup" / "scripts"))

from lockup import _classify_announcement, _fetch_announcements  # noqa: E402


# ── _classify_announcement ──────────────────────────────────────────

class TestClassify:
    def test_earnings_forecast_is_top_importance(self):
        assert _classify_announcement("2026年半年度业绩预告") == ("业绩预告/快报", 3)

    def test_earnings_express(self):
        assert _classify_announcement("2026年半年度业绩快报") == ("业绩预告/快报", 3)

    def test_restructuring(self):
        assert _classify_announcement("重大资产重组报告书") == ("重大重组", 3)

    def test_trading_halt(self):
        assert _classify_announcement("关于公司股票停牌的公告") == ("停牌/复牌", 3)

    def test_buyback(self):
        assert _classify_announcement("关于回购公司股份的方案") == ("回购", 2)

    def test_offering(self):
        assert _classify_announcement("非公开发行A股股票预案") == ("增发/配股", 2)

    def test_holder_increase(self):
        assert _classify_announcement("关于控股股东增持股份的公告") == ("股东增持", 2)

    def test_holder_decrease(self):
        assert _classify_announcement("关于大股东减持计划的预披露") == ("股东减持", 2)

    def test_dividend_low_importance(self):
        assert _classify_announcement("2025年度利润分配暨分红派息") == ("分红派息", 1)

    def test_lockup_expiry_is_filter_marker(self):
        assert _classify_announcement("关于限售股上市流通的提示性公告") == ("解禁", 0)

    def test_regulatory(self):
        assert _classify_announcement("关于收到证监会立案告知书的公告") == ("监管/处罚", 2)

    def test_other_falls_back(self):
        assert _classify_announcement("关于召开2026年第一次临时股东大会的通知") == ("其他", 1)


# ── _fetch_announcements ────────────────────────────────────────────

def _item(title, notice_date, art_code="123456"):
    return {"title": title, "notice_date": notice_date, "art_code": art_code}


def _api_resp(items):
    return MagicMock(json=lambda: {"success": True, "data": {"list": items}})


def test_classifies_filters_lockup_sorts_by_importance():
    items = [
        _item("关于公司回购股份的方案", "2026-06-01 10:00:00"),              # 回购 2
        _item("2026年半年度业绩预告", "2026-05-28 09:00:00"),                 # 业绩预告 3
        _item("关于限售股上市流通的提示性公告", "2026-05-20 00:00:00"),        # 解禁 → 过滤
        _item("2025年度利润分配暨分红派息", "2026-04-10 00:00:00"),           # 分红 1
    ]
    with patch("lockup.http_get", return_value=_api_resp(items)):
        result = _fetch_announcements("600519", "2026-06-09", lookback_days=60)

    assert len(result) == 3                       # 解禁过滤，剩 3
    assert result[0]["type"] == "业绩预告/快报"   # importance 3 排首位
    assert result[0]["importance"] == 3
    assert all(r["type"] != "解禁" for r in result)


def test_lookback_window_drops_old_notices():
    # 2026-01-01 is ~159 days before 2026-06-09, outside the 60-day window
    items = [_item("关于公司回购股份的方案", "2026-01-01 00:00:00")]
    with patch("lockup.http_get", return_value=_api_resp(items)):
        result = _fetch_announcements("600519", "2026-06-09", lookback_days=60)
    assert result == []


def test_top8_cap():
    items = [_item(f"关于公司回购股份的方案{i}", "2026-06-01 10:00:00") for i in range(10)]
    with patch("lockup.http_get", return_value=_api_resp(items)):
        result = _fetch_announcements("600519", "2026-06-09")
    assert len(result) == 8


def test_url_built_from_art_code():
    items = [_item("关于公司回购股份的方案", "2026-06-01 10:00:00", art_code="ABC987")]
    with patch("lockup.http_get", return_value=_api_resp(items)):
        result = _fetch_announcements("600519", "2026-06-09")
    assert result[0]["url"].endswith("/600519/ABC987.html")


def test_api_exception_returns_empty():
    with patch("lockup.http_get", side_effect=Exception("network down")):
        assert _fetch_announcements("600519", "2026-06-09") == []


def test_success_false_returns_empty():
    resp = MagicMock(json=lambda: {"success": False})
    with patch("lockup.http_get", return_value=resp):
        assert _fetch_announcements("600519", "2026-06-09") == []


def test_empty_title_skipped():
    items = [{"title": "", "notice_date": "2026-06-01 00:00:00", "art_code": "x"}]
    with patch("lockup.http_get", return_value=_api_resp(items)):
        assert _fetch_announcements("600519", "2026-06-09") == []


def test_unparseable_date_skipped():
    items = [_item("关于公司回购股份的方案", "not-a-date")]
    with patch("lockup.http_get", return_value=_api_resp(items)):
        assert _fetch_announcements("600519", "2026-06-09") == []
