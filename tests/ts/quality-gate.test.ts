// tests/ts/quality-gate.test.ts

import { describe, it, expect } from "vitest";
import { validateAnalystReports, checkFieldCitations, checkNullFieldSentinels } from "../../src/quality-gate";
import { AnalystReport } from "../../src/types";

function makeReport(role: string, content: string, direction = "看多", reason = "test"): AnalystReport {
  return { role, content, verdict: { direction, reason }, data_sources_used: [] };
}

const GOOD_REPORT = `
## 执行摘要

该股处于上升趋势中，均线多头排列，成交量配合良好。建议看多。

## 详细分析

### 1. 基本信息
最新收盘价 25.80 元，当日涨跌幅 +2.3%，成交量 1500 万手。

### 2. 短期趋势
近 5 日累计涨跌幅 +5.2%，短期趋势上升。

### 3. 成交量分析
近 5 日平均成交量 1200 万手，近 20 日平均成交量 1000 万手，量比 1.2。

### 4. 技术指标信号
- MACD 金叉，看多信号强
- RSI 65，中性偏高

### 5. 支撑与阻力
关键支撑位 24.50 元，关键阻力位 27.00 元。

### 6. 形态识别
底部双底形态确认。

### 7. 综合判断
趋势上升，强弱中。

<!-- VERDICT: {"direction": "看多", "reason": "均线多头排列"} -->
`;

describe("validateAnalystReports", () => {
  it("should grade all reports A when quality is good", () => {
    const reports = [
      makeReport("market", GOOD_REPORT),
      makeReport("fundamentals", GOOD_REPORT.replace("看多", "中性")),
    ];
    const result = validateAnalystReports(reports);
    expect(result.failed_count).toBe(0);
    expect(result.warn_count).toBe(0);
    expect(result.grades.every((g) => g.grade === "A")).toBe(true);
    expect(result.summary_text).toContain("market");
    expect(result.summary_text).toContain("fundamentals");
  });

  it("should grade F for empty report", () => {
    const reports = [
      makeReport("market", ""),
      makeReport("fundamentals", GOOD_REPORT),
    ];
    const result = validateAnalystReports(reports);
    expect(result.failed_count).toBe(1);
    const marketGrade = result.grades.find((g) => g.role === "market")!;
    expect(marketGrade.grade).toBe("F");
    expect(marketGrade.issues).toContain("报告为空");
  });

  it("should grade F for error placeholder", () => {
    const reports = [
      makeReport("sentiment", "[分析失败: API timeout]"),
    ];
    const result = validateAnalystReports(reports);
    expect(result.failed_count).toBe(1);
    const grade = result.grades.find((g) => g.role === "sentiment")!;
    expect(grade.grade).toBe("F");
  });

  it("should grade F for data missing placeholder", () => {
    const reports = [
      makeReport("news", "[数据缺失: no data]"),
    ];
    const result = validateAnalystReports(reports);
    expect(result.failed_count).toBe(1);
  });

  it("should grade C/D for short report", () => {
    const reports = [
      makeReport("policy", "短报告。", "中性", "无法解析结论"),
    ];
    const result = validateAnalystReports(reports);
    const grade = result.grades.find((g) => g.role === "policy")!;
    expect(["C", "D", "F"]).toContain(grade.grade);
    expect(grade.issues.some((i) => i.includes("报告过短"))).toBe(true);
  });

  it("should flag failure markers", () => {
    const content = Array(50).fill("无法获取数据 数据缺失 未能获取").join(" ");
    const reports = [
      makeReport("hot_money", content),
    ];
    const result = validateAnalystReports(reports);
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    // Should have failure marker issue
    expect(grade.issues.some((i) => i.includes("失败标记"))).toBe(true);
  });

  it("should flag unparsed verdict", () => {
    const reports = [
      makeReport("lockup", GOOD_REPORT, "中性", "无法解析结论"),
    ];
    const result = validateAnalystReports(reports);
    const grade = result.grades.find((g) => g.role === "lockup")!;
    expect(grade.issues.some((i) => i.includes("VERDICT 解析失败"))).toBe(true);
  });

  it("should include warning in summary text for failed roles", () => {
    const reports = [
      makeReport("market", ""),
      makeReport("fundamentals", GOOD_REPORT),
    ];
    const result = validateAnalystReports(reports);
    expect(result.summary_text).toContain("严重警告");
    expect(result.summary_text).toContain("market");
  });

  it("should include warning in summary text for D-grade roles", () => {
    const shortContent = "x".repeat(50); // Very short
    const reports = [
      makeReport("sentiment", shortContent, "中性", "无法解析结论"),
    ];
    const result = validateAnalystReports(reports);
    // At least one issue should be present
    expect(result.grades[0].issues.length).toBeGreaterThan(0);
  });

  it("should handle mixed quality reports", () => {
    const reports = [
      makeReport("market", GOOD_REPORT),
      makeReport("fundamentals", ""),  // F
      makeReport("news", GOOD_REPORT),
      makeReport("sentiment", "[分析失败: error]"),  // F
    ];
    const result = validateAnalystReports(reports);
    expect(result.failed_count).toBe(2);
    expect(result.warn_count).toBe(0);
    expect(result.summary_text).toContain("fundamentals");
    expect(result.summary_text).toContain("sentiment");
  });

  it("flags a water-essay report that cites no data fields (citation check)", () => {
    // No market keywords (收盘/成交量/RSI/...) and no numeric citations.
    const waterEssay =
      "该股近期表现平稳，整体走势符合预期，建议保持关注。市场环境复杂多变，" +
      "投资者需谨慎决策，结合自身风险偏好操作。未来走势仍需观察，暂无明确方向。";
    const reports = [makeReport("market", waterEssay)];
    const result = validateAnalystReports(reports);
    const grade = result.grades.find((g) => g.role === "market")!;
    expect(grade.issues.some((i) => i.includes("数据字段"))).toBe(true);
  });

  it("flags a report with ≥3 [数据缺失] sentinels even when prose is otherwise valid", () => {
    // Regression for 600600: the news report carried 13 [数据缺失: ...]
    // sentinels but got grade A. Two flaws let it through — (A) Check 4
    // counted DISTINCT marker strings (数据缺失 = 1 entry) not occurrences,
    // so 13 sentinels scored as 1; (B) Check 6's keyword match was satisfied
    // by the sentinel text itself. The sentinel-count check catches (A).
    const content = `
## 执行摘要
该股新闻面平静，近期无重大事件，建议观望。

## 详细分析
### 1. 公告
[数据缺失: 重大公告] — 接口未返回。

### 2. 行业新闻
[数据缺失: 行业新闻] — 无数据。

### 3. 调研
[数据缺失: 调研记录] — 无记录。

### 4. 综合
无明显利好利空，新闻面中性。

<!-- VERDICT: {"direction": "中性", "reason": "新闻面平静"} -->
`;
    const reports = [makeReport("news", content)];
    const result = validateAnalystReports(reports);
    const grade = result.grades.find((g) => g.role === "news")!;
    expect(grade.grade).not.toBe("A");
    expect(grade.issues.some((i) => i.includes("数据缺失") && i.includes("哨兵"))).toBe(true);
  });
});

describe("checkFieldCitations", () => {
  it("flags generic prose that cites no data fields and no numbers", () => {
    const issue = checkFieldCitations(
      "该股走势平稳，建议保持关注，暂无明确方向。",
      "market"
    );
    expect(issue).not.toBeNull();
    expect(issue).toContain("数据字段");
  });

  it("does not flag when a known field keyword is cited", () => {
    // "MACD" / "RSI" are market keywords.
    expect(checkFieldCitations("MACD 出现金叉，RSI 偏强。", "market")).toBeNull();
  });

  it("does not flag a data-grounded report with numeric citations but no keyword match", () => {
    // No fundamentals keyword, but 3+ numeric citations → engaging with data.
    expect(
      checkFieldCitations("价格 25.8 元，涨幅 2.3%，成交 1500 手。", "fundamentals")
    ).toBeNull();
  });

  it("skips unknown roles (no keyword map)", () => {
    expect(checkFieldCitations("no data here at all", "unknown_role")).toBeNull();
  });

  it("does not count a keyword that appears only inside a [数据缺失] sentinel", () => {
    // "新闻" / "公告" appear ONLY inside sentinels declaring them missing.
    // Before the fix, checkFieldCitations saw "新闻" via the sentinel text
    // and returned null (passed) — a report declaring "I have no news data"
    // was treated as if it had cited news data. After: sentinels stripped
    // before the keyword scan, so no real engagement → flagged.
    const issue = checkFieldCitations(
      "[数据缺失: 新闻] [数据缺失: 公告] [数据缺失: 调研] 该股无明显方向。",
      "news"
    );
    expect(issue).not.toBeNull();
    expect(issue).toContain("数据字段");
  });
});

describe("checkNullFieldSentinels", () => {
  // Regression for 600157 2026-06-13: hot_money had fund_flow=null +
  // sector_fund_flow=null (push2.eastmoney rate-limited per MEMORY.md),
  // analyst wrote plain-text "资金流数据缺失" instead of the mandated
  // `[数据缺失: 主力资金流]` sentinel form, and Layer-1 graded it A.
  // This check cross-references raw null fields against sentinel coverage.

  it("flags hot_money when fund_flow is null and no sentinel covers it", () => {
    const issue = checkNullFieldSentinels(
      "北向资金大幅流出，龙虎榜无数据，资金面沉寂。",  // no [数据缺失: ...]
      "hot_money",
      { fund_flow: null, sector_fund_flow: { today: -1e8 }, northbound: {} }
    );
    expect(issue).not.toBeNull();
    expect(issue).toContain("fund_flow");
  });

  it("does NOT flag when fund_flow=null but report has [数据缺失: 主力资金流] sentinel", () => {
    const issue = checkNullFieldSentinels(
      "[数据缺失: 主力资金流] — push2 接口限流。其他资金面数据正常。",
      "hot_money",
      { fund_flow: null, sector_fund_flow: { today: -1e8 } }
    );
    expect(issue).toBeNull();
  });

  it("accepts alternate keyword '资金流' inside the sentinel", () => {
    const issue = checkNullFieldSentinels(
      "[数据缺失: 个股资金流] — 接口异常。",
      "hot_money",
      { fund_flow: null }
    );
    expect(issue).toBeNull();
  });

  it("does NOT flag when fund_flow is populated (not null)", () => {
    const issue = checkNullFieldSentinels(
      "主力资金净流入 2.3 亿元。",
      "hot_money",
      { fund_flow: { today: 2.3e8, "5d": -1e8 } }
    );
    expect(issue).toBeNull();
  });

  it("does NOT flag when fund_flow is [] (empty array, not null)", () => {
    // null = fetch failed; [] = upstream returned empty (could be normal).
    // Only null counts as a data failure worth flagging.
    const issue = checkNullFieldSentinels(
      "资金面数据为空。",
      "hot_money",
      { fund_flow: [] }
    );
    expect(issue).toBeNull();
  });

  it("does NOT flag when raw field key is absent (undefined)", () => {
    const issue = checkNullFieldSentinels(
      "no mention of missing data",
      "hot_money",
      { northbound: {} }   // fund_flow key absent
    );
    expect(issue).toBeNull();
  });

  it("aggregates multiple null fields into a single issue", () => {
    const issue = checkNullFieldSentinels(
      "no sentinels here",
      "hot_money",
      { fund_flow: null, sector_fund_flow: null }
    );
    expect(issue).not.toBeNull();
    // single issue string lists both fields
    expect(issue).toContain("fund_flow");
    expect(issue).toContain("sector_fund_flow");
  });

  it("flags sentiment.hot_rank=null without sentinel", () => {
    const issue = checkNullFieldSentinels(
      "市场情绪平稳。",
      "sentiment",
      { hot_rank: null, zt_pool: null }
    );
    expect(issue).not.toBeNull();
    expect(issue).toContain("hot_rank");
    expect(issue).toContain("zt_pool");
  });

  it("flags fundamentals.financial_health=null without sentinel", () => {
    const issue = checkNullFieldSentinels(
      "PB 0.79，破净。",
      "fundamentals",
      { financial_health: null, valuation: { pb: 0.79 } }
    );
    expect(issue).not.toBeNull();
    expect(issue).toContain("financial_health");
  });

  it("returns null for roles without a null-field table (market/news/policy/lockup)", () => {
    // These roles' missing-data signals are usually [] not null — out of scope
    // until evidence of a false negative surfaces.
    expect(checkNullFieldSentinels("any content", "market", { data: null })).toBeNull();
    expect(checkNullFieldSentinels("any content", "news", { stock_news: null })).toBeNull();
  });

  it("returns null when rawData is undefined (legacy callers)", () => {
    expect(checkNullFieldSentinels("any content", "hot_money", undefined)).toBeNull();
  });

  it("returns null when rawData is not an object", () => {
    expect(checkNullFieldSentinels("any content", "hot_money", null)).toBeNull();
    expect(checkNullFieldSentinels("any content", "hot_money", "string")).toBeNull();
  });
});

describe("validateAnalystReports with dataResults (null-field cross-check)", () => {
  // Helper: build a dataResults entry mimicking orchestrator's shape
  function dataResult(role: string, data: Record<string, unknown>) {
    return { role, result: { success: true, data } };
  }

  // Long-enough hot_money report body (≥200 chars to clear Check 3 min-length),
  // with role keywords (北向/主力/龙虎榜/板块) so Check 6 citation passes.
  const HOT_MONEY_BODY = `
## 执行摘要

北向资金连续 3 日大幅流出，累计净流出 40 亿元，板块资金小幅流入但力度有限。
龙虎榜无上榜记录，游资活跃度低。综合判断资金面呈中性偏空，建议观望。

## 详细分析

### 1. 北向资金
今日沪股通净流出 9.28 亿元，深股通净流出 31.1 亿元，合计 40.38 亿元。
近 5 日累计净流出超 120 亿元，外资持续减仓信号明确。

### 2. 主力资金
个股主力资金净流入数据缺失（详见下文哨兵），板块方面煤炭板块资金小幅流入。

### 3. 龙虎榜与游资
近 5 日无龙虎榜上榜记录，知名游资席位无动向，市场关注度低。

<!-- VERDICT: {"direction": "中性", "reason": "资金面真空"} -->
`;

  it("downgrades hot_money A→B when fund_flow=null and report has no sentinel", () => {
    // 600157 scenario: would normally grade A — but raw data has fund_flow=null.
    const reports = [makeReport("hot_money", HOT_MONEY_BODY, "中性", "资金面真空")];
    const dataResults = [dataResult("hot_money", {
      fund_flow: null,
      sector_fund_flow: null,
      northbound: { total: -40.38 },
      hot_stocks: [],
      dragon_tiger: []
    })];
    const result = validateAnalystReports(reports, dataResults);
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    expect(grade.grade).toBe("B");  // was A before the fix
    expect(grade.issues.some((i) => i.includes("fund_flow"))).toBe(true);
  });

  it("keeps hot_money at A when fund_flow=null AND report has matching sentinel", () => {
    const content = HOT_MONEY_BODY.replace(
      "个股主力资金净流入数据缺失（详见下文哨兵），板块方面煤炭板块资金小幅流入。",
      "[数据缺失: 主力资金流] — push2 接口限流。\n[数据缺失: 板块资金流] — push2 接口限流。"
    );
    const reports = [makeReport("hot_money", content, "中性", "资金面真空")];
    const dataResults = [dataResult("hot_money", {
      fund_flow: null,
      sector_fund_flow: null,
      northbound: { total: -40.38 }
    })];
    const result = validateAnalystReports(reports, dataResults);
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    expect(grade.grade).toBe("A");
  });

  it("is backward-compatible: omitting dataResults keeps legacy behavior", () => {
    // Old callers that don't pass dataResults should see no behavior change.
    const reports = [makeReport("hot_money", HOT_MONEY_BODY, "中性", "资金面真空")];
    const result = validateAnalystReports(reports);  // no dataResults
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    expect(grade.grade).toBe("A");
    expect(grade.issues.some((i) => i.includes("fund_flow"))).toBe(false);
  });

  it("skips roles whose raw data failed (success=false)", () => {
    // If the script itself errored, result.data is undefined — no cross-check.
    const reports = [makeReport("hot_money", HOT_MONEY_BODY, "中性", "资金面真空")];
    const dataResults = [{
      role: "hot_money",
      result: { success: false, error: "push2 unreachable" }
    }];
    const result = validateAnalystReports(reports, dataResults);
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    expect(grade.issues.some((i) => i.includes("fund_flow"))).toBe(false);
  });
});

describe("Check 8: dragon_tiger date continuity (hot_money fabrication guard)", () => {
  // Regression for 688163 2026-06-14: hot_money report claimed "连续两日
  // 20%涨停" but dragon_tiger had only ONE entry (2026-06-12); 2026-06-13
  // had no data. Layer-1 graded it A; Layer-2 LLM caught the fabrication.
  // This structural check closes that gap at zero LLM cost.

  const REPORT_WITH连续两日 = `
## 执行摘要

该股龙虎榜显示游资介入，连续两日 20% 涨停彰显强势。北向资金流出 40 亿。

## 详细分析

### 1. 龙虎榜
上榜日期 2026-06-12，净买入 5156 万元。连续两日涨停，缩量封板。

### 2. 北向资金
全市场净流出 -40 亿元。

<!-- VERDICT: {"direction": "看多", "reason": "游资净买入且连续涨停"} -->
`;

  const REPORT_WITH连续3日 = `
## 执行摘要

该股连续 3 日涨停，游资接力。

## 详细分析

### 1. 龙虎榜
上榜 3 次，最近一次净买入 5000 万元。

### 2. 北向资金
全市场净流出 -40 亿元。

<!-- VERDICT: {"direction": "看多", "reason": "连续 3 日涨停"} -->
`;

  const REPORT_NO连续短语 = `
## 执行摘要

该股龙虎榜显示游资介入，强势涨停。北向资金流出 40 亿。

## 详细分析

### 1. 龙虎榜
上榜日期 2026-06-12，净买入 5156 万元。

### 2. 北向资金
全市场净流出 -40 亿元。

<!-- VERDICT: {"direction": "看多", "reason": "游资净买入"} -->
`;

  function makeHotMoneyDataResults(dragonTiger: unknown[]) {
    return [{
      role: "hot_money",
      result: { success: true, data: { dragon_tiger: dragonTiger } },
    }];
  }

  it("flags '连续两日' claim when dragon_tiger has only 1 entry (688163 regression)", () => {
    const reports = [makeReport("hot_money", REPORT_WITH连续两日)];
    const dataResults = makeHotMoneyDataResults([
      { date: "2026-06-12", net_buy: 51565000 },
    ]);
    const result = validateAnalystReports(reports, dataResults);
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    const issue = grade.issues.find((i) => i.includes("连续"));
    expect(issue).toBeDefined();
    expect(issue).toContain("龙虎榜");
    expect(issue).toContain("1");
  });

  it("does NOT flag when dragon_tiger entries match the claim", () => {
    const reports = [makeReport("hot_money", REPORT_WITH连续3日)];
    const dataResults = makeHotMoneyDataResults([
      { date: "2026-06-10" }, { date: "2026-06-11" }, { date: "2026-06-12" },
    ]);
    const result = validateAnalystReports(reports, dataResults);
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    expect(grade.issues.some((i) => i.includes("连续"))).toBe(false);
  });

  it("flags '连续两日' claim when dragon_tiger is empty", () => {
    const reports = [makeReport("hot_money", REPORT_WITH连续两日)];
    const dataResults = makeHotMoneyDataResults([]);
    const result = validateAnalystReports(reports, dataResults);
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    expect(grade.issues.some((i) => i.includes("连续"))).toBe(true);
  });

  it("does NOT run the check for non-hot_money roles", () => {
    // A market report could plausibly mention "连续两日涨停" too, but the
    // dragon_tiger data is hot_money-specific — the check must scope to role.
    const reports = [makeReport("market", REPORT_WITH连续两日)];
    const dataResults = [{
      role: "market",
      result: { success: true, data: { dragon_tiger: [] } },
    }];
    const result = validateAnalystReports(reports, dataResults);
    const grade = result.grades.find((g) => g.role === "market")!;
    expect(grade.issues.some((i) => i.includes("连续") && i.includes("龙虎榜"))).toBe(false);
  });

  it("does NOT run the check when rawData is absent", () => {
    const reports = [makeReport("hot_money", REPORT_WITH连续两日)];
    const result = validateAnalystReports(reports);  // no dataResults
    const grade = result.grades.find((g) => g.role === "hot_money")!;
    expect(grade.issues.some((i) => i.includes("连续"))).toBe(false);
  });
});
