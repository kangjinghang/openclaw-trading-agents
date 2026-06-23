"""
Tests for _score_dragon_tiger in skills/trading-hot-money/scripts/hot_money.py.

No network calls — pure function tests on synthetic data.
"""

import sys
from pathlib import Path

import pytest

hot_money_dir = Path(__file__).parent.parent.parent / "skills" / "trading-hot-money" / "scripts"
sys.path.insert(0, str(hot_money_dir))

from hot_money import _score_dragon_tiger  # noqa: E402


class TestScoreDragonTiger:
    """Test 5-dimension dragon tiger scoring logic."""

    def test_empty_records_returns_none(self):
        assert _score_dragon_tiger([]) is None

    def test_single_record_positive_net_buy(self):
        records = [{
            "date": "2025-01-15",
            "reason": "涨幅偏离值达11.17%",
            "net_buy": 5000.0,
            "buy_amt": 8000.0,
            "sell_amt": 3000.0,
            "turnover": 12.5,
            "close_price": 15.3,
            "change_rate": 10.0,
        }]
        result = _score_dragon_tiger(records)
        assert len(result) == 1
        rec = result[0]
        assert rec["composite_score"] > 0
        assert rec["net_inflow"] > 10  # 5000万 should give >10 pts
        assert rec["sell_pressure"] > 0  # sell ratio = 3/8 = 0.375

    def test_known_hot_money_gets_high_quality(self):
        records = [{
            "date": "2025-01-15",
            "reason": "赵老哥买入",
            "net_buy": 100.0,
            "buy_amt": 200.0,
            "sell_amt": 100.0,
            "turnover": 5.0,
            "close_price": 10.0,
            "change_rate": 5.0,
        }]
        result = _score_dragon_tiger(records)
        assert result[0]["capital_quality"] >= 10.0  # 赵老哥 = known

    def test_institution_resonance_highest(self):
        records = [{
            "date": "2025-01-15",
            "reason": "机构专用 买入",
            "net_buy": 100.0,
            "buy_amt": 200.0,
            "sell_amt": 100.0,
        }]
        result = _score_dragon_tiger(records)
        assert result[0]["institution_resonance"] >= 5.0

    def test_high_sell_pressure_low_score(self):
        records = [{
            "date": "2025-01-15",
            "reason": "上榜",
            "net_buy": -5000.0,  # net outflow
            "buy_amt": 1000.0,
            "sell_amt": 6000.0,  # heavy selling
            "turnover": 8.0,
            "close_price": 12.0,
            "change_rate": -8.0,
        }]
        result = _score_dragon_tiger(records)
        assert result[0]["sell_pressure"] < 5  # sell ratio > 80% → low score
        assert result[0]["net_inflow"] < 5  # negative net → low score

    def test_hot_concept_bonus(self):
        records = [{
            "date": "2025-01-15",
            "reason": "AI芯片半导体概念",
            "net_buy": 5000.0,
            "buy_amt": 6000.0,
            "sell_amt": 1000.0,
        }]
        result = _score_dragon_tiger(records)
        # Should get bonus for AI + 芯片 + 半导体
        assert result[0]["bonus"] >= 0.9  # 3 concepts × 0.3

    def test_sorted_by_composite_desc(self):
        records = [
            {"date": "2025-01-15", "reason": "赵老哥买入AI", "net_buy": 8000.0,
             "buy_amt": 10000.0, "sell_amt": 2000.0, "change_rate": 5.0},
            {"date": "2025-01-14", "reason": "上榜", "net_buy": 500.0,
             "buy_amt": 1000.0, "sell_amt": 500.0, "change_rate": 1.0},
        ]
        result = _score_dragon_tiger(records)
        assert result[0]["composite_score"] > result[1]["composite_score"]

    def test_composite_score_capped_at_100(self):
        """Even extreme records shouldn't exceed 100."""
        records = [{
            "date": "2025-01-15",
            "reason": "赵老哥 机构专用 AI芯片 新能源 买入",
            "net_buy": 50000.0,
            "buy_amt": 60000.0,
            "sell_amt": 1000.0,
            "change_rate": 9.9,
        }]
        result = _score_dragon_tiger(records)
        assert result[0]["composite_score"] <= 100
