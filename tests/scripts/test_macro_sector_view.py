"""
Tests for _build_macro_sector_view in skills/trading-news/scripts/news.py.

No network calls — pure rule engine tests on synthetic data.
"""

import sys
from pathlib import Path

import pytest

news_dir = Path(__file__).parent.parent.parent / "skills" / "trading-news" / "scripts"
sys.path.insert(0, str(news_dir))

from news import _build_macro_sector_view  # noqa: E402


class TestBuildMacroSectorView:
    """Test rule-based macro → sector mapping engine."""

    def test_bullish_when_strong_macro(self):
        """Strong M2 + PMI > 50 + retail > 4% → bullish."""
        indicators = {
            "m2_yoy": {"latest": 8.0},
            "manufacturing_pmi": {"latest": 52.0},
            "retail_sales_yoy": {"latest": 5.0},
            "fixed_asset_yoy": {"latest": 4.0},
            "ppi_yoy": {"latest": 1.0},
            "real_estate_invest_yoy": {"latest": 3.0},
            "urban_unemployment": {"latest": 5.0},
        }
        result = _build_macro_sector_view(indicators)
        assert result["total_score"] > 0
        assert result["market_view"] in ("震荡偏多", "结构性机会为主")
        assert len(result["bullish_sectors"]) > 0

    def test_bearish_when_weak_macro(self):
        """Weak PMI < 50 + PPI < 0 + RE < 0 → bearish."""
        indicators = {
            "manufacturing_pmi": {"latest": 48.0},
            "ppi_yoy": {"latest": -2.0},
            "real_estate_invest_yoy": {"latest": -5.0},
            "m2_yoy": {"latest": 4.0},
            "retail_sales_yoy": {"latest": 1.0},
            "fixed_asset_yoy": {"latest": -1.0},
            "urban_unemployment": {"latest": 5.5},
        }
        result = _build_macro_sector_view(indicators)
        assert result["total_score"] < 0
        assert result["market_view"] == "震荡偏谨慎"
        assert len(result["bearish_sectors"]) > 0

    def test_realestate_penalized_heavily(self):
        """Real estate investment < 0 should penalize 地产/建材/建筑."""
        indicators = {
            "real_estate_invest_yoy": {"latest": -8.0},
        }
        result = _build_macro_sector_view(indicators)
        # 建筑 and 建材 should appear in bearish (both get -3 from RE + -2 from 建材 itself)
        assert "房地产" in result["bearish_sectors"]

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
