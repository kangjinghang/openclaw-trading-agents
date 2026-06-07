import { describe, it, expect } from "vitest";
import { toMarkdown, toHtml } from "../../src/report-formatter";
import { QuickAnalysisResult, FullAnalysisResult } from "../../src/types";

const quickResult: QuickAnalysisResult = {
  ticker: "600519",
  date: "2026-06-07",
  mode: "quick",
  analysts: [
    {
      role: "market",
      content: "Strong upward momentum",
      verdict: { direction: "看多", reason: "技术指标看涨" },
      data_sources_used: ["kline"],
    },
    {
      role: "fundamentals",
      content: "PE undervalued",
      verdict: { direction: "看多", reason: "PE处于历史低位" },
      data_sources_used: ["fundamentals"],
    },
    {
      role: "news",
      content: "Positive news flow",
      verdict: { direction: "中性", reason: "消息面多空交织" },
      data_sources_used: ["news"],
    },
  ],
  final: {
    ticker: "600519",
    company_name: "贵州茅台",
    date: "2026-06-07",
    direction: "Buy",
    confidence: 0.75,
    target_price: 1800,
    stop_loss: 1500,
    position_pct: 10,
    reasoning: "估值合理，趋势向好",
    key_risks: ["政策风险", "消费降级"],
    analyst_verdicts: { market: "看多", fundamentals: "看多", news: "中性" },
    bull_bear_summary: "",
    risk_assessment: "pass",
    execution_plan: "分批建仓",
    next_review_trigger: "",
  },
};

const fullResult: FullAnalysisResult = {
  ...quickResult,
  mode: "full",
  debate: {
    rounds: [
      {
        round: 1,
        bull_claims: [
          {
            id: "BULL-1",
            side: "bull",
            topic: "估值极低",
            evidence: "PE仅19倍",
            confidence: 0.9,
          },
        ],
        bear_claims: [
          {
            id: "BEAR-1",
            side: "bear",
            topic: "资金面恶化",
            evidence: "北向资金流出",
            confidence: 0.7,
          },
        ],
      },
    ],
    bull_summary: "估值处于底部，安全边际高",
    bear_summary: "资金面承压，短期缺乏弹性",
    total_tokens: 1000,
    total_cost_usd: 0.01,
  },
  research_decision: {
    direction: "Overweight",
    confidence: 0.7,
    bull_score: 85,
    bear_score: 60,
    reasoning: "基本面优秀，建议超配",
    key_debate_points: [],
    verdict: { direction: "Overweight", reason: "基本面优秀" },
  },
  trading_plan: {
    direction: "Buy",
    target_price: 1800,
    stop_loss: 1500,
    position_pct: 10,
    execution_plan: "### 交易计划\n- **目标价格**：1800元\n- **止损价格**：1500元",
    entry_signals: ["股价突破1800"],
    exit_signals: ["跌破止损"],
    key_risks: ["政策风险"],
    t_plus_1_note: "T+1制度：当日买入次日才能卖出",
  },
  risk_debate: {
    rounds: [
      [
        {
          role: "aggressive",
          position: "支持",
          evidence: ["估值安全"],
          verdict: "pass",
        },
        {
          role: "conservative",
          position: "支持",
          evidence: ["风控合规"],
          verdict: "pass",
        },
        {
          role: "neutral",
          position: "支持",
          evidence: ["盈亏比合理"],
          verdict: "pass",
        },
      ],
    ],
    risk_arguments: [],
    total_tokens: 500,
    total_cost_usd: 0.005,
  },
  risk_assessment: {
    status: "pass",
    reasoning: "风险可控",
    risk_score: 40,
  },
};

describe("report-formatter", () => {
  describe("toMarkdown", () => {
    it("should render quick analysis markdown", () => {
      const md = toMarkdown(quickResult);
      expect(md).toContain("600519 分析报告");
      expect(md).toContain("## 最终决策");
      expect(md).toContain("买入 Buy");
      expect(md).toContain("1800 元");
      expect(md).toContain("政策风险");
      expect(md).toContain("## 分析师观点");
      expect(md).toContain("market");
      expect(md).toContain("看多 Bullish");
      expect(md).not.toContain("## 多空辩论");
    });

    it("should render full analysis with debate and risk", () => {
      const md = toMarkdown(fullResult);
      expect(md).toContain("## 多空辩论 (1 轮)");
      expect(md).toContain("估值极低");
      expect(md).toContain("资金面恶化");
      expect(md).toContain("## 研究经理裁决");
      expect(md).toContain("85");
      expect(md).toContain("## 交易执行计划");
      expect(md).toContain("1800 元");
      expect(md).toContain("## 风控评估");
      expect(md).toContain("风险可控");
    });

    it("should handle missing target_price gracefully", () => {
      const result = {
        ...quickResult,
        final: { ...quickResult.final, target_price: 0 },
      };
      const md = toMarkdown(result);
      expect(md).toContain("## 最终决策");
      expect(md).not.toContain("| 目标价 |");
    });
  });

  describe("toHtml", () => {
    it("should render valid HTML with analyst table", () => {
      const html = toHtml(quickResult);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html");
      expect(html).toContain("</html>");
      expect(html).toContain("<table>");
      expect(html).toContain("看多 Bullish");
      expect(html).toContain("中性 Neutral");
    });

    it("should render full mode with all sections", () => {
      const html = toHtml(fullResult);
      expect(html).toContain("多空辩论");
      expect(html).toContain("研究经理裁决");
      expect(html).toContain("交易执行计划");
      expect(html).toContain("风控评估");
      // Should have direction badges
      expect(html).toContain("border-radius:12px");
    });

    it("should convert bold markdown in execution plan to <strong>", () => {
      const html = toHtml(fullResult);
      expect(html).toContain("<strong>目标价格</strong>");
      expect(html).toContain("<strong>止损价格</strong>");
    });
  });
});
