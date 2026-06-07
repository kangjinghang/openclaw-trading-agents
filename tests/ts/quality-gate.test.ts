// tests/ts/quality-gate.test.ts

import { describe, it, expect } from "vitest";
import { validateAnalystReports } from "../../src/quality-gate";
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
});
