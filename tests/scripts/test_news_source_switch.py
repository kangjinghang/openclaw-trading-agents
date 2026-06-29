"""sentiment.py + policy.py 新闻源切换测试（iwencai 主源 + 东财兜底）。

验证 _fetch_stock_news / _fetch_policy_news 的三路径：
  1. iwencai 主源命中 → 用 iwencai 数据，source="iwencai"
  2. iwencai 主源空（未配 key/失败）→ 走东财兜底，source="eastmoney"（兜底有数据时）
  3. 两者都空 → source="none"

全 mock 网络，无真实流量。
"""

import sys
from pathlib import Path
from unittest import mock

import pytest

# _shared（iwencai_client / http_helpers）
shared_dir = Path(__file__).parent.parent.parent / "skills" / "_shared"
sys.path.insert(0, str(shared_dir))
# news.py（policy.py import 它）
news_dir = Path(__file__).parent.parent.parent / "skills" / "trading-news" / "scripts"
sys.path.insert(0, str(news_dir))
# sentiment / policy 自身
sentiment_dir = Path(__file__).parent.parent.parent / "skills" / "trading-sentiment" / "scripts"
sys.path.insert(0, str(sentiment_dir))
policy_dir = Path(__file__).parent.parent.parent / "skills" / "trading-policy" / "scripts"
sys.path.insert(0, str(policy_dir))


# ════════════════════════════════════════════════════════════════════════
# sentiment.py: _fetch_stock_news
# ════════════════════════════════════════════════════════════════════════

def _iw_article(title="测试新闻", content="内容", time="2026-06-29 10:00:00", source="问财"):
    return {"title": title, "content": content, "time": time, "source": source}


def test_sentiment_news_iwencai_primary_hit():
    """iwencai 主源命中 → 用 iwencai 数据，source=iwencai，东财兜底不被调用。"""
    import sentiment
    iw_articles = [_iw_article("利好消息", "业绩超预期")]
    with mock.patch.object(sentiment, "get_iwencai_client") as gi, \
         mock.patch.object(sentiment, "_fetch_stock_news_eastmoney") as ge:
        gi.return_value.search_news.return_value = iw_articles
        articles, source = sentiment._fetch_stock_news("贵州茅台")
    assert source == "iwencai"
    assert len(articles) == 1
    assert articles[0]["title"] == "利好消息"
    ge.assert_not_called()  # 主源命中，兜底不应被调用


def test_sentiment_news_iwencai_empty_falls_back_to_eastmoney():
    """iwencai 主源空 → 走东财兜底，兜底有数据时 source=eastmoney。"""
    import sentiment
    em_articles = [{"title": "东财新闻", "content": "x", "time": "2026-06-29", "source": "东财"}]
    with mock.patch.object(sentiment, "get_iwencai_client") as gi, \
         mock.patch.object(sentiment, "_fetch_stock_news_eastmoney", return_value=em_articles) as ge:
        gi.return_value.search_news.return_value = []
        articles, source = sentiment._fetch_stock_news("贵州茅台")
    assert source == "eastmoney"
    assert len(articles) == 1
    ge.assert_called_once_with("贵州茅台")


def test_sentiment_news_both_empty_returns_none():
    """iwencai 空 + 东财兜底也空 → source=none。"""
    import sentiment
    with mock.patch.object(sentiment, "get_iwencai_client") as gi, \
         mock.patch.object(sentiment, "_fetch_stock_news_eastmoney", return_value=[]) as ge:
        gi.return_value.search_news.return_value = []
        articles, source = sentiment._fetch_stock_news("贵州茅台")
    assert source == "none"
    assert articles == []


# ════════════════════════════════════════════════════════════════════════
# policy.py: _fetch_policy_news（注意 time→date 字段映射）
# ════════════════════════════════════════════════════════════════════════

def test_policy_news_iwencai_primary_maps_time_to_date():
    """iwencai 主源命中：time 字段映射为下游期望的 date 字段。"""
    import policy
    # iwencai 返回 time，下游期望 date
    iw_articles = [_iw_article("政策利好", "降准", time="2026-06-20 08:00:00", source="证券时报")]
    with mock.patch.object(policy, "get_iwencai_client") as gi, \
         mock.patch.object(policy, "_fetch_policy_eastmoney") as ge:
        gi.return_value.search_news.return_value = iw_articles
        articles, source = policy._fetch_policy_news("贵州茅台", lookback_days=30)
    assert source == "iwencai"
    assert len(articles) == 1
    assert articles[0]["date"] == "2026-06-20"  # time → date 映射
    assert articles[0]["title"] == "政策利好"
    assert articles[0]["source"] == "证券时报"
    ge.assert_not_called()


def test_policy_news_iwencai_filters_old_articles():
    """iwencai 返回的文章超过 lookback_days 被过滤，全过期则走东财兜底。"""
    import policy
    from datetime import datetime, timedelta
    old_date = (datetime.now() - timedelta(days=60)).strftime("%Y-%m-%d")
    iw_articles = [_iw_article("旧新闻", time=old_date)]
    em_articles = [{"date": "2026-06-25", "title": "东财新闻", "content": "x", "source": "东财"}]
    with mock.patch.object(policy, "get_iwencai_client") as gi, \
         mock.patch.object(policy, "_fetch_policy_eastmoney", return_value=em_articles) as ge:
        gi.return_value.search_news.return_value = iw_articles
        articles, source = policy._fetch_policy_news("贵州茅台", lookback_days=30)
    # iwencai 文章全过期（lookback=30，文章 60 天前）→ 主源空 → 走东财兜底
    assert source == "eastmoney"
    assert len(articles) == 1


def test_policy_news_both_empty_returns_none():
    """iwencai 空 + 东财兜底也空 → source=none。"""
    import policy
    with mock.patch.object(policy, "get_iwencai_client") as gi, \
         mock.patch.object(policy, "_fetch_policy_eastmoney", return_value=[]) as ge:
        gi.return_value.search_news.return_value = []
        articles, source = policy._fetch_policy_news("贵州茅台", lookback_days=30)
    assert source == "none"
    assert articles == []
