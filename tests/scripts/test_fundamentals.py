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

from fundamentals import _derive_financial_health, _percentile_of_latest, _fetch_valuation_percentile  # noqa: E402

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


class TestPercentileOfLatest:
    """_percentile_of_latest：当前值在序列里的百分位（0-100，手写避免 numpy）。"""

    def test_latest_at_top_returns_near_100(self):
        # 50 个点，当前值最大 → 接近 100
        seq = list(range(1, 51))  # 当前值 50
        assert _percentile_of_latest(seq) == 100.0

    def test_latest_at_bottom_returns_zero(self):
        seq = [50] + list(range(2, 51))  # 当前值 50... 等等，当前在最后
        # 构造当前值最小：最后一个是 1，其余 2..51
        seq = list(range(2, 52)) + [1]
        assert _percentile_of_latest(seq) == 0.0

    def test_latest_in_middle_returns_50(self):
        # 101 个点（1..100 + 当前值 50），当前值 50 正中间
        # 低于 50 的有 1..49 共 49 个，分位 = 49/(101-1)*100 = 49.0
        seq = list(range(1, 101)) + [50]
        assert _percentile_of_latest(seq) == 49.0

    def test_too_short_series_returns_none(self):
        assert _percentile_of_latest([1, 2, 3]) is None  # <30 点

    def test_filters_none_and_nonpositive(self):
        # 混入 None/0/负数应被过滤，不影响计算
        seq = list(range(1, 31)) + [0, None, -5]
        assert _percentile_of_latest(seq) == 100.0  # 当前值 30 最大


class TestFetchValuationPercentile:
    """_fetch_valuation_percentile：mock akshare 的 baidu 估值接口。"""

    def test_returns_percentiles_when_akshare_succeeds(self, monkeypatch):
        import pandas as pd
        # 构造 731 行的近10年序列，当前值（最后一行）偏高 → 高分位
        dates = pd.date_range("2016-06-24", periods=731, freq="D").strftime("%Y-%m-%d")
        pe_values = list(range(1, 732))  # 当前 731（最大）
        pb_values = list(range(1, 732, 1))[:731]

        def fake_baidu(symbol, indicator, period):
            vals = pe_values if "市盈率" in indicator else pb_values
            return pd.DataFrame({"date": dates[:len(vals)], "value": vals})

        import sys as _sys
        class FakeAk:
            stock_zh_valuation_baidu = staticmethod(fake_baidu)
        monkeypatch.setitem(_sys.modules, "akshare", FakeAk)

        res = _fetch_valuation_percentile("600519")
        assert res is not None
        assert "pe_percentile" in res
        assert "pb_percentile" in res
        # 5年裁剪后仍 >30 点，当前值最大 → 高分位
        assert res["pe_percentile"] >= 90

    def test_returns_none_when_akshare_missing(self, monkeypatch):
        import builtins
        real_import = builtins.__import__
        def block_akshare(name, *a, **k):
            if name == "akshare":
                raise ImportError("no akshare")
            return real_import(name, *a, **k)
        monkeypatch.setattr(builtins, "__import__", block_akshare)
        assert _fetch_valuation_percentile("600519") is None

    def test_returns_none_when_series_too_short(self, monkeypatch):
        import pandas as pd
        # 只有 10 行（裁剪后 <30）→ None
        def fake_baidu(symbol, indicator, period):
            return pd.DataFrame({"date": ["2026-01-0%d" % i for i in range(1, 11)],
                                 "value": list(range(10, 20))})
        import sys as _sys
        class FakeAk:
            stock_zh_valuation_baidu = staticmethod(fake_baidu)
        monkeypatch.setitem(_sys.modules, "akshare", FakeAk)
        assert _fetch_valuation_percentile("600519") is None

    def test_crops_to_5_years(self, monkeypatch):
        """验证裁剪：10 年序列但只有最近 1 年有数据足够多时，分位基于近 5 年。
        构造：前 6 年全是低值，近 4 年（在 5 年窗口内）全是高值，当前值中等。
        若不裁剪，当前值会被远古低值拉高分位；裁剪后基于近 5 年。"""
        import pandas as pd
        from datetime import datetime, timedelta
        base = datetime(2026, 6, 24)
        dates = [(base - timedelta(days=365 * 9 - i)).strftime("%Y-%m-%d") for i in range(731)]
        # 前 500 个低值（PE=5），后 231 个高值（PE=50），当前值 50
        values = [5] * 500 + [50] * 231
        def fake_baidu(symbol, indicator, period):
            return pd.DataFrame({"date": dates, "value": values})
        import sys as _sys
        class FakeAk:
            stock_zh_valuation_baidu = staticmethod(fake_baidu)
        monkeypatch.setitem(_sys.modules, "akshare", FakeAk)
        res = _fetch_valuation_percentile("600519")
        assert res is not None
        # 裁剪到近5年后，序列里高值占主导，当前值 50 不再是最大但分位应较高
        assert res["pe_percentile"] >= 50
