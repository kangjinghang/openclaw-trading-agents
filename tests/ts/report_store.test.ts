import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ReportStore } from "../../src/report-store";
import { QuickAnalysisResult, QualitySummary, QualityReview } from "../../src/types";

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

    // Verify no .tmp files left behind (atomic write cleanup)
    const allFiles = fs.readdirSync(path.join(tmpDir, "600519"), { recursive: true }) as string[];
    const tmpFiles = allFiles.filter(f => String(f).endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("Should not leave .tmp files on successful write (atomic writes)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-store-test-"));

    const result: QuickAnalysisResult = {
      ticker: "000001",
      date: "2026-01-01",
      mode: "quick",
      analysts: [],
      final: {
        ticker: "000001", company_name: "TEST", date: "2026-01-01",
        direction: "Hold", confidence: 0.5, target_price: 0, stop_loss: 0,
        position_pct: 0, reasoning: "test", key_risks: [],
        analyst_verdicts: {}, bull_bear_summary: "",
        risk_assessment: "pass", execution_plan: "", next_review_trigger: "",
      },
    };

    const store = new ReportStore(tmpDir);
    store.save("000001", "2026-01-01", "quick", result, 1000, 0, 0, "run-test");

    // Check no .tmp files anywhere in the output
    const allFiles = fs.readdirSync(path.join(tmpDir, "000001"), { recursive: true }) as string[];
    const tmpFiles = allFiles.filter(f => String(f).endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    // Verify summary has run_id
    const summary = JSON.parse(fs.readFileSync(path.join(tmpDir, "000001", "2026-01-01_quick.json"), "utf-8"));
    expect(summary.run_id).toBe("run-test");
  });
});

describe("ReportStore.saveQualitySummary", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function mockQuality(): QualitySummary {
    return {
      grades: [
        { role: "market", grade: "A", issues: [] },
        { role: "news", grade: "B", issues: ["包含 13 个 [数据缺失] 哨兵"] },
      ],
      failed_count: 0,
      warn_count: 0,
      summary_text: "## 数据质量门控报告\n| 分析师 | 等级 | 问题 |",
    };
  }

  function mockReview(): QualityReview {
    return {
      credibility: "中",
      note: "部分报告数据偏旧",
      stale_reports: ["fundamentals"],
      fabrication_suspects: [],
    };
  }

  it("Should persist Layer-1 grades + Layer-2 review to 00_quality.json", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "quality-store-test-"));
    const store = new ReportStore(tmpDir);

    store.saveQualitySummary("600600", "2026-06-09", "full", mockQuality(), mockReview());

    const qPath = path.join(tmpDir, "600600", "2026-06-09_full", "00_quality.json");
    expect(fs.existsSync(qPath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(qPath, "utf-8"));
    // Layer-1: deterministic grades + counts + injected-prompt text
    expect(saved.layer1.grades).toHaveLength(2);
    expect(saved.layer1.grades[0]).toEqual({ role: "market", grade: "A", issues: [] });
    expect(saved.layer1.grades[1].grade).toBe("B");
    expect(saved.layer1.failed_count).toBe(0);
    expect(saved.layer1.warn_count).toBe(0);
    expect(saved.layer1.summary_text).toContain("数据质量门控报告");
    // Layer-2: LLM credibility review
    expect(saved.layer2.credibility).toBe("中");
    expect(saved.layer2.stale_reports).toEqual(["fundamentals"]);
    expect(saved.layer2.fabrication_suspects).toEqual([]);
  });

  it("Should write layer2: null when Layer-2 review is absent (skipped or failed)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "quality-store-test-"));
    const store = new ReportStore(tmpDir);

    // Layer-2 returns null when ≥4 hard-fails or LLM call fails — Layer-1 still
    // must persist so the deterministic grades remain queryable.
    store.saveQualitySummary("600600", "2026-06-09", "full", mockQuality(), null);

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600600", "2026-06-09_full", "00_quality.json"), "utf-8")
    );
    expect(saved.layer1.grades).toHaveLength(2);
    expect(saved.layer2).toBeNull();
  });

  it("Should not leave .tmp files (atomic write)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "quality-store-test-"));
    const store = new ReportStore(tmpDir);

    store.saveQualitySummary("600600", "2026-06-09", "full", mockQuality(), mockReview());

    const allFiles = fs.readdirSync(path.join(tmpDir, "600600"), { recursive: true }) as string[];
    const tmpFiles = allFiles.filter((f) => String(f).endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});
