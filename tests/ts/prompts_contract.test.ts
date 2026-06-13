import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Stable contracts over prompt templates: these assert that key guardrail
// sections survive prompt edits. They check section headers + a few anchor
// phrases, not full wording, so routine rephrasing doesn't break them.
const PROMPTS = path.resolve(
  __dirname,
  "../../skills/trading-analysis/prompts"
);

describe("prompt contracts", () => {
  it("research_manager.md gates HOLD behind a 3-condition anti-laziness rule", () => {
    const md = fs.readFileSync(
      path.join(PROMPTS, "debate/research_manager.md"),
      "utf-8"
    );
    expect(md).toContain("## HOLD 判定约束");
    expect(md).toContain("技术面无明确趋势");
    expect(md).toContain("资金面无明确方向");
    expect(md).toContain("基本面与新闻面无近期催化剂");
  });

  it("trader.md anchors its direction to the research manager", () => {
    const md = fs.readFileSync(
      path.join(PROMPTS, "debate/trader.md"),
      "utf-8"
    );
    expect(md).toContain("## 方向锚定规则");
    expect(md).toContain("必须与研究经理的决策一致");
  });

  it("fundamentals.md exposes the derived financial_health field", () => {
    const md = fs.readFileSync(
      path.join(PROMPTS, "analysts/fundamentals.md"),
      "utf-8"
    );
    expect(md).toContain("financial_health");
    expect(md).toContain("goodwill_to_equity_pct");
    expect(md).toContain("ocf_to_ni_ratio");
  });

  it("market.md requires cross-dimension technical-indicator coverage", () => {
    const md = fs.readFileSync(
      path.join(PROMPTS, "analysts/market.md"),
      "utf-8"
    );
    expect(md).toContain("跨维度");
    // all four dimensions must appear in the discipline rule
    expect(md).toContain("趋势");
    expect(md).toContain("动量");
    expect(md).toContain("量能");
    expect(md).toContain("价格");
  });

  it("every analyst prompt mandates the [数据缺失] sentinel for missing data", () => {
    const files = [
      "market",
      "fundamentals",
      "news",
      "sentiment",
      "policy",
      "hot_money",
      "lockup",
    ];
    for (const f of files) {
      const md = fs.readFileSync(
        path.join(PROMPTS, `analysts/${f}.md`),
        "utf-8"
      );
      // the mandated sentinel format analysts must use inline
      expect(md).toContain("[数据缺失: 指标名]");
      // anti-skip / anti-fabricate rule
      expect(md).toContain("严禁跳过");
    }
  });

  it("quality_review.md is a credibility-review prompt with the QUALITY_REVIEW protocol", () => {
    const md = fs.readFileSync(
      path.join(PROMPTS, "quality_review.md"),
      "utf-8"
    );
    expect(md).toContain("数据可信度"); // credibility lens (not investment merit)
    expect(md).toContain("数据时效"); // staleness check
    expect(md).toContain("QUALITY_REVIEW"); // output protocol
    expect(md).toContain("credibility"); // JSON field
    expect(md).toContain("{{reports}}"); // reports placeholder
    expect(md).toContain("{{grades_table}}"); // Layer-1 grades placeholder
  });

  it("portfolio_manager.md and research_manager.md cap confidence under data vacuum", () => {
    // Regression for 600157 (2026-06-13): PM saw 6/7 analysts graded B + Layer-2
    // credibility=低 + 1 fabrication_suspect, yet still output Hold @ 85%.
    // The prompts now mandate explicit confidence ceilings keyed to quality
    // grades so "data vacuum → neutral" can't masquerade as "balanced → high confidence".
    const files = [
      { path: "portfolio_manager.md", term: "置信度" },
      { path: "debate/research_manager.md", term: "信心水平" },
    ];
    for (const f of files) {
      const md = fs.readFileSync(path.join(PROMPTS, f.path), "utf-8");
      expect(md).toContain("数据质量约束");          // section header
      expect(md).toContain("严禁把");                // anti-masquerading rule
      expect(md).toContain(f.term + "上限");         // confidence ceiling keyword (per-file term)
      expect(md).toContain("≥4 名");                 // numeric trigger
      expect(md).toContain("0.6");                   // first ceiling value
    }
  });
});
