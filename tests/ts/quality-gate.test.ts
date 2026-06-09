// tests/ts/quality-gate.test.ts

import { describe, it, expect } from "vitest";
import { validateAnalystReports, checkFieldCitations } from "../../src/quality-gate";
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
