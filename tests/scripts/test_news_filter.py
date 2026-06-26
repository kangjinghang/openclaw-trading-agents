"""
Tests for news.py lookback filtering + dedup + <em> tag stripping.

These are the defenses that keep stock_news clean after the eastmoney-only
refactor (pywencai removed). Network-free — tests the pure functions directly:
  - _filter_recent: lookback裁剪 + 去重（根治 2024 老研报混入 prompt 的问题）
  - _strip_em_tags: 去除东财搜索结果的高亮标签
"""

import sys
from pathlib import Path

import pytest

news_dir = Path(__file__).parent.parent.parent / "skills" / "trading-news" / "scripts"
sys.path.insert(0, str(news_dir))

import news  # noqa: E402


# ── _filter_recent ──────────────────────────────────────────────────


class TestFilterRecentLookback:
    """lookback 裁剪：早于窗口的文章应被丢弃。"""

    def test_drops_article_outside_lookback_window(self):
        """2024 老研报在 2026-06-25 + lookback 7 天的窗口外 → 被裁掉。"""
        articles = [
            {"title": "半年报业绩符合预期", "time": "2024-08-23 00:00:00"},  # 远超窗口
            {"title": "最新动态", "time": "2026-06-24 10:00:00"},            # 窗口内
            {"title": "上周新闻", "time": "2026-06-20 10:00:00"},            # 5 天前，窗口内
        ]
        kept = news._filter_recent(articles, "2026-06-25", lookback_days=7)
        titles = [a["title"] for a in kept]
        assert "半年报业绩符合预期" not in titles  # 2024 被裁
        assert "最新动态" in titles
        assert "上周新闻" in titles  # 6-20 距 6-25 是 5 天，在 7 天窗口内

    def test_boundary_just_inside_window_kept(self):
        """恰好在窗口边界（lookback_days 天前）的文章应保留。"""
        articles = [
            {"title": "边界", "time": "2026-06-18 23:59:59"},  # 7 天前
            {"title": "超期", "time": "2026-06-17 23:59:59"},  # 8 天前
        ]
        # ref 2026-06-25 23:59:59 - 7d = 2026-06-18 23:59:59，边界值保留（>=）
        kept = news._filter_recent(articles, "2026-06-25", lookback_days=7)
        titles = [a["title"] for a in kept]
        assert "边界" in titles
        assert "超期" not in titles

    def test_unparseable_time_kept(self):
        """时间解析失败的文章保留——宁多勿少，防误杀当天突发新闻。

        东财 date 偶有 "MM-DD" 无年份简写或非标格式，解析失败时不应丢弃。
        """
        articles = [
            {"title": "无年份", "time": "06-25 10:00"},
            {"title": "空时间", "time": ""},
            {"title": "乱格式", "time": "刚刚"},
        ]
        kept = news._filter_recent(articles, "2026-06-25", lookback_days=7)
        assert len(kept) == 3  # 全部保留

    def test_invalid_reference_date_uses_now(self):
        """参考日期解析失败 → 退化为 datetime.now()，不崩溃。"""
        articles = [{"title": "x", "time": "2026-06-24 10:00:00"}]
        # 不应抛异常
        kept = news._filter_recent(articles, "not-a-date", lookback_days=7)
        assert len(kept) >= 0


class TestFilterRecentDedup:
    """去重：title 完全相同（trim 后）视为重复，保留首条。"""

    def test_drops_exact_duplicate_title(self):
        """同篇研报被源返回多次 → 只保留首条。"""
        articles = [
            {"title": "中科曙光半年报点评", "time": "2026-06-24 10:00:00"},
            {"title": "中科曙光半年报点评", "time": "2026-06-24 10:00:00"},  # 完全重复
            {"title": "另一条新闻", "time": "2026-06-24 11:00:00"},
        ]
        kept = news._filter_recent(articles, "2026-06-25", lookback_days=7)
        titles = [a["title"] for a in kept]
        assert titles.count("中科曙光半年报点评") == 1
        assert "另一条新闻" in titles
        assert len(kept) == 2

    def test_dedup_normalizes_whitespace(self):
        """title 前后空白不同但内容相同 → 去重。"""
        articles = [
            {"title": "  研报标题  ", "time": "2026-06-24 10:00:00"},
            {"title": "研报标题", "time": "2026-06-24 10:00:00"},
        ]
        kept = news._filter_recent(articles, "2026-06-25", lookback_days=7)
        assert len(kept) == 1

    def test_empty_title_not_deduped_against_each_other(self):
        """空 title 不互相去重（避免把多条无标题新闻合并成一条）。"""
        articles = [
            {"title": "", "time": "2026-06-24 10:00:00"},
            {"title": "", "time": "2026-06-24 11:00:00"},
        ]
        kept = news._filter_recent(articles, "2026-06-25", lookback_days=7)
        assert len(kept) == 2


class TestFilterRecentCombined:
    """裁剪 + 去重组合（模拟真实 pywencai 曾返回的脏数据）。"""

    def test_stale_duplicate_research_notes_all_removed(self):
        """复现 pywencai 实测脏数据：3 条 2024 重复研报 + 1 条最新 → 只留最新。"""
        articles = [
            {"title": "中科曙光半年报点评", "time": "2024-08-23 00:00:00"},
            {"title": "中科曙光半年报点评", "time": "2024-08-23 00:00:00"},  # 重复
            {"title": "中科曙光半年报点评", "time": "2024-08-23 00:00:00"},  # 重复
            {"title": "最新订单", "time": "2026-06-25 09:00:00"},
        ]
        kept = news._filter_recent(articles, "2026-06-25", lookback_days=7)
        assert len(kept) == 1
        assert kept[0]["title"] == "最新订单"

    def test_empty_input_returns_empty(self):
        assert news._filter_recent([], "2026-06-25", 7) == []


# ── _filter_relevance ───────────────────────────────────────────────


class TestFilterRelevance:
    """相关性过滤：挡掉纯板块新闻，只保留个股相关新闻。"""

    def test_keeps_title_with_company_name(self):
        """title 含公司全名 → 保留（真个股新闻）。"""
        articles = [
            {"title": "中科曙光：历军当选董事长兼总经理", "content": "...", "code": "603019"},
            {"title": "计算机行业资金流出榜", "content": "...紫光股份等...", "code": "000938"},
        ]
        kept = news._filter_relevance(articles, "中科曙光", "603019")
        titles = [a["title"] for a in kept]
        assert "中科曙光：历军当选董事长兼总经理" in titles
        assert "计算机行业资金流出榜" not in titles

    def test_keeps_content_start_with_company_name(self):
        """content 前 80 字含公司名 → 保留（正文开头的个股新闻）。"""
        articles = [
            {"title": "一季报点评", "content": "中科曙光发布2026年一季报，净利润2.28亿元..." + "x" * 200},
            {"title": "板块新闻", "content": "计算机行业今日资金流出，" + "y" * 200 + "中科曙光"},
        ]
        kept = news._filter_relevance(articles, "中科曙光", "603019")
        titles = [a["title"] for a in kept]
        # 第1条正文开头含公司名 → 保留
        assert "一季报点评" in titles
        # 第2条公司名在 content 末尾（>80字）→ 挡掉
        assert "板块新闻" not in titles

    def test_drops_code_only_in_content_tail(self):
        """代码只在 content 末尾关联列表 → 丢弃（纯板块新闻）。"""
        articles = [
            {
                "title": "中国AI 50概念下跌4.76%",
                "content": "今日AI概念板块回调，多只个股下跌。" + "z" * 100 + " 603019 -2.3%",
            },
        ]
        kept = news._filter_relevance(articles, "中科曙光", "603019")
        assert len(kept) == 0

    def test_fallback_code_in_title_without_company_name(self):
        """无 company_name 时，代码在 title → 保留（分析师 pipeline 降级路径）。"""
        articles = [
            {"title": "603019一季报净利润2.28亿", "content": "..."},
            {"title": "板块新闻", "content": "... 603019 ..."},
        ]
        kept = news._filter_relevance(articles, None, "603019")
        titles = [a["title"] for a in kept]
        assert "603019一季报净利润2.28亿" in titles
        assert "板块新闻" not in titles  # 代码只在 content，不在 title

    def test_no_company_no_code_match_keeps_none(self):
        """无 company_name 且代码不在任何 title → 全挡。"""
        articles = [
            {"title": "板块新闻A", "content": "603019"},
            {"title": "板块新闻B", "content": "..."},
        ]
        kept = news._filter_relevance(articles, None, "603019")
        assert len(kept) == 0

    def test_empty_input(self):
        assert news._filter_relevance([], "中科曙光", "603019") == []

    def test_short_name_not_used_for_matching(self):
        """不用简称切片匹配——'中科'会误匹配中科信息等同源公司。

        只匹配完整公司名，避免误放行同前缀的其他公司新闻。
        """
        articles = [
            {"title": "中科信息发布新产品", "content": "..."},  # 不同公司，前缀相同
            {"title": "中科曙光发布新产品", "content": "..."},
        ]
        kept = news._filter_relevance(articles, "中科曙光", "603019")
        titles = [a["title"] for a in kept]
        assert "中科曙光发布新产品" in titles
        assert "中科信息发布新产品" not in titles  # 不用"中科"简称匹配


# ── _strip_em_tags ──────────────────────────────────────────────────


class TestStripEmTags:
    """去除东财搜索结果的 <em>关键词高亮</em> 标签。"""

    def test_strips_em_tags(self):
        assert news._strip_em_tags("中国AI 5<em>0</em>概念下跌") == "中国AI 50概念下跌"

    def test_strips_multiple_em_tags(self):
        text = "<em>603019</em>中标<em>5亿</em>项目"
        assert news._strip_em_tags(text) == "603019中标5亿项目"

    def test_no_tags_unchanged(self):
        assert news._strip_em_tags("普通标题无标签") == "普通标题无标签"

    def test_empty_or_none(self):
        assert news._strip_em_tags("") == ""
        assert news._strip_em_tags(None) is None
