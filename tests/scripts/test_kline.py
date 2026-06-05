"""
Tests for trading-kline skill.
Tests the kline.py script with mocked data sources.
"""

import sys
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Add skills directory to path so we can import kline module
skills_dir = Path(__file__).parent.parent.parent / "skills"
sys.path.insert(0, str(skills_dir / "trading-kline" / "scripts"))

from kline import fetch, fetch_from_mootdx, fetch_from_akshare, DataFetchError, detect_market


class TestDetectMarket:
    """Tests for market detection logic."""

    def test_shanghai_market_6xx(self):
        """Test Shanghai market detection for 6xx tickers."""
        assert detect_market("600519") == 1
        assert detect_market("600000") == 1
        assert detect_market("601988") == 1

    def test_shanghai_market_68x(self):
        """Test Shanghai market detection for 68x (STAR Market) tickers."""
        assert detect_market("688981") == 1
        assert detect_market("688599") == 1

    def test_shenzhen_market_0xx(self):
        """Test Shenzhen market detection for 0xx tickers."""
        assert detect_market("000001") == 0
        assert detect_market("000002") == 0
        assert detect_market("002594") == 0

    def test_shenzhen_market_3xx(self):
        """Test Shenzhen market detection for 3xx (ChiNext) tickers."""
        assert detect_market("300750") == 0
        assert detect_market("300059") == 0

    def test_unknown_ticker_raises_error(self):
        """Test that unknown ticker formats raise DataFetchError."""
        with pytest.raises(DataFetchError, match="Unknown ticker format"):
            detect_market("999999")
        with pytest.raises(DataFetchError, match="Unknown ticker format"):
            detect_market("5xxxxx")


class TestFetchFromMootdx:
    """Tests for mootdx data source."""

    def test_returns_json_with_price_data(self):
        """Test that mootdx returns JSON with price data on success."""
        # Mock the mootdx import at the module level
        mock_quotes_class = MagicMock()
        mock_quotes = MagicMock()
        mock_quotes_class.factory.return_value = mock_quotes

        # Create mock dataframe
        import pandas as pd
        mock_df = pd.DataFrame({
            'date': ['2024-01-02', '2024-01-03'],
            'open': [100.0, 101.0],
            'high': [105.0, 106.0],
            'low': [99.0, 100.0],
            'close': [104.0, 105.0],
            'volume': [1000000, 1100000],
            'amount': [104000000, 115500000]
        })
        mock_quotes.std.return_value = mock_df

        # Patch sys.modules to prevent actual import
        with patch.dict('sys.modules', {'mootdx.quotes': MagicMock(Quotes=mock_quotes_class)}):
            # Execute
            result = fetch_from_mootdx("600519", 2)

            # Assert
            assert result["ticker"] == "600519"
            assert result["count"] == 2
            assert len(result["data"]) == 2
            assert result["data"][0]["date"] == "2024-01-02"
            assert result["data"][0]["open"] == 100.0
            assert result["data"][0]["close"] == 104.0

    def test_raises_on_empty_dataframe(self):
        """Test that empty dataframe raises DataFetchError."""
        import pandas as pd

        mock_quotes_class = MagicMock()
        mock_quotes = MagicMock()
        mock_quotes_class.factory.return_value = mock_quotes
        mock_quotes.std.return_value = pd.DataFrame()

        with patch.dict('sys.modules', {'mootdx.quotes': MagicMock(Quotes=mock_quotes_class)}):
            with pytest.raises(DataFetchError, match="No data returned"):
                fetch_from_mootdx("600519", 60)

    def test_raises_on_connection_failure(self):
        """Test that connection failure raises DataFetchError."""
        mock_quotes_class = MagicMock()
        mock_quotes_class.factory.side_effect = Exception("Connection failed")

        with patch.dict('sys.modules', {'mootdx.quotes': MagicMock(Quotes=mock_quotes_class)}):
            with pytest.raises(DataFetchError, match="mootdx fetch failed"):
                fetch_from_mootdx("600519", 60)

    def test_raises_on_import_error(self):
        """Test that missing mootdx import raises DataFetchError."""
        # Make the import fail
        with patch.dict('sys.modules', {'mootdx.quotes': None}):
            with patch('builtins.__import__', side_effect=ImportError("No module named 'mootdx'")):
                with pytest.raises(DataFetchError, match="mootdx not installed"):
                    fetch_from_mootdx("600519", 60)


class TestFetchFromAkshare:
    """Tests for akshare fallback data source."""

    def test_returns_json_with_price_data(self):
        """Test that akshare returns JSON with price data on success."""
        import pandas as pd

        mock_ak = MagicMock()
        mock_df = pd.DataFrame({
            '日期': ['2024-01-02', '2024-01-03'],
            '开盘': [100.0, 101.0],
            '最高': [105.0, 106.0],
            '最低': [99.0, 100.0],
            '收盘': [104.0, 105.0],
            '成交量': [1000000, 1100000],
            '成交额': [104000000, 115500000]
        })
        mock_ak.stock_zh_a_hist.return_value = mock_df

        with patch.dict('sys.modules', {'akshare': mock_ak}):
            # Execute
            result = fetch_from_akshare("600519", 2)

            # Assert
            assert result["ticker"] == "600519"
            assert result["count"] == 2
            assert len(result["data"]) == 2
            assert result["data"][0]["date"] == "2024-01-02"
            assert result["data"][0]["open"] == 100.0
            assert result["data"][0]["close"] == 104.0

    def test_raises_on_empty_dataframe(self):
        """Test that empty dataframe raises DataFetchError."""
        import pandas as pd

        mock_ak = MagicMock()
        mock_ak.stock_zh_a_hist.return_value = pd.DataFrame()

        with patch.dict('sys.modules', {'akshare': mock_ak}):
            with pytest.raises(DataFetchError, match="No data returned"):
                fetch_from_akshare("600519", 60)

    def test_raises_on_connection_failure(self):
        """Test that connection failure raises DataFetchError."""
        mock_ak = MagicMock()
        mock_ak.stock_zh_a_hist.side_effect = Exception("Network error")

        with patch.dict('sys.modules', {'akshare': mock_ak}):
            with pytest.raises(DataFetchError, match="akshare fetch failed"):
                fetch_from_akshare("600519", 60)

    def test_raises_on_import_error(self):
        """Test that missing akshare import raises DataFetchError."""
        # Make the import fail
        with patch.dict('sys.modules', {'akshare': None}):
            with patch('builtins.__import__', side_effect=ImportError("No module named 'akshare'")):
                with pytest.raises(DataFetchError, match="akshare not installed"):
                    fetch_from_akshare("600519", 60)


class TestFetchWithFallback:
    """Tests for the main fetch function with fallback logic."""

    @patch('kline.fetch_from_akshare')
    @patch('kline.fetch_from_mootdx')
    def test_returns_success_from_primary_source(self, mock_mootdx, mock_akshare):
        """Test that successful fetch from mootdx returns immediately."""
        mock_mootdx.return_value = {
            "ticker": "600519",
            "count": 2,
            "data": [{"date": "2024-01-02"}]
        }

        result = fetch("600519", 2)

        assert result["success"] is True
        assert result["_source"] == "mootdx"
        assert result["data"]["ticker"] == "600519"
        # Akshare should not be called when mootdx succeeds
        mock_akshare.assert_not_called()

    @patch('kline.fetch_from_akshare')
    @patch('kline.fetch_from_mootdx')
    def test_falls_back_to_akshare_on_mootdx_failure(self, mock_mootdx, mock_akshare):
        """Test that akshare is called when mootdx fails."""
        # Mootdx fails
        mock_mootdx.side_effect = DataFetchError("mootdx unavailable")

        # Akshare succeeds
        mock_akshare.return_value = {
            "ticker": "600519",
            "count": 2,
            "data": [{"date": "2024-01-02"}]
        }

        result = fetch("600519", 2)

        assert result["success"] is True
        assert result["_source"] == "akshare"
        mock_mootdx.assert_called_once()
        mock_akshare.assert_called_once()

    @patch('kline.fetch_from_akshare')
    @patch('kline.fetch_from_mootdx')
    def test_raises_data_fetch_error_when_all_sources_fail(self, mock_mootdx, mock_akshare):
        """Test that DataFetchError is raised when both sources fail."""
        mock_mootdx.side_effect = DataFetchError("mootdx failed")
        mock_akshare.side_effect = DataFetchError("akshare failed")

        result = fetch("600519", 2)

        assert result["success"] is False
        assert "error" in result


class TestIntegration:
    """Integration tests for the complete workflow."""

    def test_detect_market_handles_edge_cases(self):
        """Test market detection with edge cases."""
        # Single digit variations
        assert detect_market("600000") == 1
        assert detect_market("000001") == 0
        assert detect_market("300000") == 0
        assert detect_market("680000") == 1

    def test_data_fetch_error_is_exception(self):
        """Test that DataFetchError is an exception class."""
        assert issubclass(DataFetchError, Exception)
        error = DataFetchError("test error")
        assert str(error) == "test error"

    def test_sources_list_exists(self):
        """Test that SOURCES list is defined."""
        from kline import SOURCES
        assert isinstance(SOURCES, list)
        assert "mootdx" in SOURCES
        assert "akshare" in SOURCES
