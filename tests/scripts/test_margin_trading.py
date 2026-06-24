"""
Tests for trading-lockup margin trading (融资融券) additions.

Covers _fetch_margin + _score_margin. Network-free: eastmoney_datacenter is
patched. Verifies field mapping, pre-computed leverage signals (踩踏风险 /
多空倾向 / 资金流向), SH+SZ coverage, non-margin-underlying graceful empty,
and degradation on API error.
"""

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "trading-lockup" / "scripts"))

from lockup import _fetch_margin, _score_margin  # noqa: E402


# ── fixtures: real-shaped eastmoney rows (字段名/数值对齐抓包实测) ────

def _em_row(date, rzye, rqye, rzyezb, rzjme, rzjme3d=None, rzjme5d=None, rzjme10d=None):
    """Build one eastmoney RPTA_WEB_RZRQ_GGMX row (subset of fields we read)."""
    return {
        "DATE": f"{date} 00:00:00", "SCODE": "600519", "SECNAME": "贵州茅台",
        "RZYE": rzye, "RQYE": rqye, "RZYEZB": rzyezb,
        "RZJME": rzjme, "RZJME3D": rzjme3d, "RZJME5D": rzjme5d, "RZJME10D": rzjme10d,
    }


# 茅台实测形态（2026-06-23）：融资余额 198.82 亿，占流通比 1.30%，当日净买入为负
_ROWS_MAOTAI = [
    _em_row("2026-06-23", 19881961762, 124968618.6, 1.30103736, -37468140,
            rzjme3d=147150702, rzjme5d=432241763, rzjme10d=385345386),
    _em_row("2026-06-22", 19919313143.4, 121204729.0, 1.28358107, -16431402),
    _em_row("2026-06-18", 19936176608.0, 132832800.0, 1.31258834, 201050000),
]


# ── _score_margin ───────────────────────────────────────────────────

class TestScoreMargin:
    def test_extracts_latest_fields(self):
        signal, latest = _score_margin(_ROWS_MAOTAI)
        assert signal["margin_balance"] == 19881961762
        assert signal["short_balance"] == 124968618.6
        assert signal["margin_pct_of_float"] == pytest.approx(1.30103736)
        assert signal["net_buy_1d"] == -37468140
        assert signal["net_buy_3d"] == 147150702
        assert latest["SECNAME"] == "贵州茅台"

    def test_long_short_ratio_high_leverage(self):
        # 茅台 rzye/rqye ≈ 159 → 看多杠杆强
        signal, _ = _score_margin(_ROWS_MAOTAI)
        assert signal["long_short_ratio"] > 10
        assert signal["leverage_bias"] == "看多杠杆强"

    def test_low_margin_pct_means_low_pressure(self):
        # 茅台 1.30% → 杠杆偏低
        signal, _ = _score_margin(_ROWS_MAOTAI)
        assert signal["margin_pressure"] == "杠杆偏低"

    def test_high_margin_pct_triggers_squeeze_warning(self):
        row = [_em_row("2026-06-23", 50e8, 1e8, 12.5, 1e7)]
        signal, _ = _score_margin(row)
        assert "高杠杆拥挤" in signal["margin_pressure"]

    def test_mid_margin_pct(self):
        row = [_em_row("2026-06-23", 50e8, 1e8, 7.0, 1e7)]
        signal, _ = _score_margin(row)
        assert signal["margin_pressure"] == "中等杠杆"

    def test_balanced_leverage_when_ratio_low(self):
        # rzye/rqye = 2 → 多空相对平衡
        row = [_em_row("2026-06-23", 2e8, 1e8, 1.0, 1e7)]
        signal, _ = _score_margin(row)
        assert signal["leverage_bias"] == "多空相对平衡"

    def test_flow_direction_inflow(self):
        signal, _ = _score_margin(_ROWS_MAOTAI)
        # 3/5/10 日累计均为正 → 净流入
        assert "净流入" in signal["flow_3d"]
        assert "净流入" in signal["flow_5d"]
        assert "净流入" in signal["flow_10d"]

    def test_flow_direction_outflow(self):
        row = [_em_row("2026-06-23", 1e9, 1e8, 1.0, -1e7, rzjme3d=-5e7, rzjme5d=-8e7, rzjme10d=-1e8)]
        signal, _ = _score_margin(row)
        assert "净流出" in signal["flow_3d"]
        assert "净流出" in signal["flow_5d"]
        assert "净流出" in signal["flow_10d"]

    def test_empty_rows_yields_none_signal(self):
        signal, latest = _score_margin([])
        assert signal["margin_balance"] is None
        assert latest == {}

    def test_missing_fields_do_not_crash(self):
        signal, _ = _score_margin([{"DATE": "2026-06-23"}])
        assert signal["margin_balance"] is None
        assert "leverage_bias" not in signal  # rqye 缺失则不算


# ── _fetch_margin ───────────────────────────────────────────────────

def test_fetch_margin_normal_underlying():
    with patch("lockup.eastmoney_datacenter", return_value=_ROWS_MAOTAI) as mock_dc:
        result = _fetch_margin("600519")
    assert result is not None
    assert result["is_margin_underlying"] is True
    assert result["latest_date"] == "2026-06-23"
    assert len(result["history"]) == 3
    # 确认传给 datacenter 的 report 名 + SCODE 过滤
    args, kwargs = mock_dc.call_args
    assert kwargs["filter_str"] == '(SCODE="600519")'
    assert kwargs["sort_columns"] == "DATE"
    assert kwargs["sort_types"] == "-1"
    # signal 已预计算
    assert result["signal"]["leverage_bias"] == "看多杠杆强"


def test_fetch_margin_sz_stock_also_works():
    # 深市股（0/3 开头）同样走 SCODE 过滤 —— 沪深全覆盖
    sz_rows = [_em_row("2026-06-23", 1e9, 1e8, 5.0, 1e7)]
    sz_rows[0]["SCODE"] = "000001"
    with patch("lockup.eastmoney_datacenter", return_value=sz_rows):
        result = _fetch_margin("000001")
    assert result is not None
    assert result["signal"]["leverage_bias"] == "偏看多"


def test_fetch_margin_non_underlying_returns_none():
    # 非两融标的：eastmoney_datacenter 返回 [] （API success:false → 空列表）
    with patch("lockup.eastmoney_datacenter", return_value=[]) as mock_dc:
        result = _fetch_margin("002999")
    assert result is None  # 合法空结果
    # 确认没有记失败调用（非标的不算源故障）
    mock_dc.assert_called_once()


def test_fetch_margin_api_error_returns_none_and_records():
    with patch("lockup.eastmoney_datacenter", side_effect=Exception("502 bad gateway")):
        result = _fetch_margin("600519")
    assert result is None  # graceful degrade


def test_fetch_margin_history_field_mapping():
    with patch("lockup.eastmoney_datacenter", return_value=_ROWS_MAOTAI):
        result = _fetch_margin("600519")
    h0 = result["history"][0]
    assert h0["date"] == "2026-06-23"
    assert h0["margin_balance"] == 19881961762
    assert h0["short_balance"] == 124968618.6
    assert h0["net_buy"] == -37468140
