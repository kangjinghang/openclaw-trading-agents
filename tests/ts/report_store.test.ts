import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ReportStore } from "../../src/report-store";
import { QuickAnalysisResult } from "../../src/types";

describe("ReportStore", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Should save a quick analysis report to ticker directory", () => {
    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-store-test-"));

    // Create a realistic QuickAnalysisResult
    const result: QuickAnalysisResult = {
      ticker: "600519",
      date: "2026-06-05",
      mode: "quick",
      analysts: [{
        role: "market",
        content: "Strong technical indicators suggest upward momentum.",
        verdict: {
          direction: "Buy",
          reason: "Strong fundamentals and positive market sentiment"
        },
        data_sources_used: ["market_data", "technical_indicators"]
      }],
      final: {
        ticker: "600519",
        company_name: "Kweichow Moutai",
        date: "2026-06-05",
        direction: "Buy",
        confidence: 0.85,
        target_price: 1850.0,
        stop_loss: 1650.0,
        position_pct: 5.0,
        reasoning: "Strong brand, consistent growth, favorable market conditions",
        key_risks: ["Regulatory changes", "Economic slowdown"],
        analyst_verdicts: {
          market: "Buy"
        },
        bull_bear_summary: "Bull: Strong fundamentals. Bear: Policy uncertainty.",
        risk_assessment: "pass",
        execution_plan: "Accumulate on dips near 1700",
        next_review_trigger: "Quarterly earnings"
      }
    };

    // Create store and save
    const store = new ReportStore(tmpDir);
    store.save(
      "600519",
      "2026-06-05",
      "quick",
      result,
      15000, // duration_ms
      2500,  // total_tokens
      0.012  // total_cost_usd
    );

    // Verify summary file exists
    const summaryPath = path.join(tmpDir, "600519", "2026-06-05_quick.json");
    expect(fs.existsSync(summaryPath)).toBe(true);

    // Verify saved JSON has correct values
    const summaryContent = fs.readFileSync(summaryPath, "utf-8");
    const summary = JSON.parse(summaryContent);
    expect(summary.final.direction).toBe("Buy");
    expect(summary.total_cost_usd).toBe(0.012);
    expect(summary.ticker).toBe("600519");
    expect(summary.mode).toBe("quick");

    // Verify detail directory exists
    const detailDir = path.join(tmpDir, "600519", "2026-06-05_quick");
    expect(fs.existsSync(detailDir)).toBe(true);

    // Verify analyst detail file exists
    const analystPath = path.join(detailDir, "01_analysts", "market.json");
    expect(fs.existsSync(analystPath)).toBe(true);

    // Verify analyst content
    const analystContent = fs.readFileSync(analystPath, "utf-8");
    const analyst = JSON.parse(analystContent);
    expect(analyst.role).toBe("market");
    expect(analyst.verdict.direction).toBe("Buy");
    expect(analyst.data_sources_used).toEqual(["market_data", "technical_indicators"]);
  });
});
