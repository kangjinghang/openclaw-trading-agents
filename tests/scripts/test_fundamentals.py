"""
Tests for trading-fundamentals skill.
Focuses on the pure financial-health derivation (network-free).
"""

import sys
import json
from pathlib import Path

import pytest

# Add skills directory to path so we can import the fundamentals module
skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "trading-fundamentals" / "scripts"))

from fundamentals import _derive_financial_health  # noqa: E402

YI = 1e8


def _maps(date="20251231", **overrides):
    """Build a one-period (bs, cf, is) map tuple with sane defaults.

    Defaults model a healthy company: goodwill 40% of equity (impairment
    risk), debt 40%, current 2.0, OCF/NI 1.67 (good). Any field can be
    overridden or nulled via kwargs grouped by statement prefix.
    """
    bs = {
        "商誉": 40 * YI,
        "归属于母公司股东权益合计": 100 * YI,
        "资产总计": 200 * YI,
        "负债合计": 80 * YI,
        "流动资产合计": 120 * YI,
        "流动负债合计": 60 * YI,
        "存货": 20 * YI,
    }
    cf = {
        "经营活动产生的现金流量净额": 50 * YI,
        "购建固定资产、无形资产和其他长期资产所支付的现金": 10 * YI,
    }
    ins = {"归属于母公司所有者的净利润": 30 * YI}
    bs.update(overrides.get("bs", {}))
    cf.update(overrides.get("cf", {}))
    ins.update(overrides.get("income", {}))
    return {date: dict(bs)}, {date: dict(cf)}, {date: dict(ins)}


class TestDeriveBasic:
    """Core ratio correctness from a full-data period."""

    def test_derives_all_fields_with_expected_values(self):
        bs, cf, ins = _maps("20251231")
        res = _derive_financial_health(bs, cf, ins)
        assert res is not None
        row = res["latest"]
        assert row["date"] == "2025-12-31"
        assert row["period_type"] == "FY"
        assert row["goodwill_yi"] == 40.0
        assert row["goodwill_to_equity_pct"] == 40.0          # 40/100
        assert row["debt_ratio_pct"] == 40.0                  # 80/200
        assert row["current_ratio"] == 2.0                    # 120/60
        assert row["quick_ratio"] == round((120 - 20) / 60, 2)  # 1.67
        assert row["ocf_yi"] == 50.0
        assert row["capex_yi"] == 10.0
        assert row["fcf_yi"] == 40.0                          # 50-10
        assert row["net_profit_parent_yi"] == 30.0
        assert row["ocf_to_ni_ratio"] == round(50 / 30, 2)    # 1.67

    def test_period_type_labeling(self):
        for d, expect in [("20250331", "Q1"), ("20250630", "H1"),
                          ("20250930", "Q3"), ("20251231", "FY")]:
            bs, cf, ins = _maps(d)
            res = _derive_financial_health(bs, cf, ins)
            assert res["latest"]["period_type"] == expect


class TestFlagsAndQuality:
    """Summary flags derived from the latest period."""

    def test_goodwill_impairment_risk_true_above_30pct(self):
        bs, cf, ins = _maps(bs={"商誉": 31 * YI, "归属于母公司股东权益合计": 100 * YI})
        assert _derive_financial_health(bs, cf, ins)["goodwill_impairment_risk"] is True

    def test_goodwill_impairment_risk_false_at_or_below_30pct(self):
        bs, cf, ins = _maps(bs={"商誉": 30 * YI, "归属于母公司股东权益合计": 100 * YI})
        assert _derive_financial_health(bs, cf, ins)["goodwill_impairment_risk"] is False

    def test_goodwill_impairment_risk_false_when_goodwill_missing(self):
        bs, cf, ins = _maps(bs={"商誉": None})
        res = _derive_financial_health(bs, cf, ins)
        assert res["goodwill_impairment_risk"] is False
        assert res["latest"]["goodwill_yi"] is None
        assert res["latest"]["goodwill_to_equity_pct"] is None

    @pytest.mark.parametrize("ocf,expect", [(50, "good"), (20, "ok"), (10, "weak"), (0, "weak")])
    def test_ocf_quality_thresholds(self, ocf, expect):
        # net_profit_parent fixed at 30亿
        bs, cf, ins = _maps(cf={"经营活动产生的现金流量净额": ocf * YI})
        assert _derive_financial_health(bs, cf, ins)["ocf_quality"] == expect

    def test_ocf_quality_weak_when_net_profit_missing(self):
        bs, cf, ins = _maps(income={"归属于母公司所有者的净利润": None})
        res = _derive_financial_health(bs, cf, ins)
        assert res["ocf_quality"] == "weak"
        assert res["latest"]["ocf_to_ni_ratio"] is None


class TestPeriodsAndDegradation:
    """Period selection, ordering, and graceful degradation."""

    def test_limits_to_n_periods_newest_first(self):
        bs = cf = ins = {}
        for date in ["20211231", "20221231", "20231231", "20241231", "20251231"]:
            b, c, i = _maps(date)
            bs.update(b); cf.update(c); ins.update(i)
        res = _derive_financial_health(bs, cf, ins, periods=3)
        assert len(res["periods"]) == 3
        assert res["periods"][0]["date"] == "2025-12-31"  # newest first
        assert res["latest"]["date"] == "2025-12-31"

    def test_uses_intersection_of_dates_present_in_all_three(self):
        bs, cf, ins = _maps("20251231")
        # add a period present only in bs (should be ignored)
        extra_b, _, _ = _maps("20240630")
        bs.update(extra_b)
        res = _derive_financial_health(bs, cf, ins)
        assert len(res["periods"]) == 1
        assert res["periods"][0]["date"] == "2025-12-31"

    def test_returns_none_when_no_overlap(self):
        bs, _, _ = _maps("20251231")
        _, cf, _ = _maps("20241231")
        _, _, ins = _maps("20231231")
        assert _derive_financial_health(bs, cf, ins) is None

    def test_returns_none_when_any_statement_empty(self):
        bs, cf, ins = _maps()
        assert _derive_financial_health({}, cf, ins) is None
        assert _derive_financial_health(bs, {}, ins) is None
        assert _derive_financial_health(bs, cf, {}) is None

    def test_missing_field_degrades_to_none_not_nan(self):
        bs, cf, ins = _maps(bs={"存货": None, "流动负债合计": None})
        row = _derive_financial_health(bs, cf, ins)["latest"]
        # current/quick ratio unavailable when current liabilities missing
        assert row["current_ratio"] is None
        assert row["quick_ratio"] is None

    def test_output_is_valid_json_no_nan(self):
        # Mix of present + missing fields to stress NaN handling.
        bs, cf, ins = _maps(bs={"商誉": None, "存货": None})
        res = _derive_financial_health(bs, cf, ins)
        # Must round-trip through strict JSON (bare NaN/inf would fail).
        js = json.dumps(res, allow_nan=False)
        json.loads(js)
