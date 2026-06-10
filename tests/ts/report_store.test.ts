import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ReportStore } from "../../src/report-store";
import { QuickAnalysisResult, FullAnalysisResult, QualitySummary, QualityReview } from "../../src/types";

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

describe("ReportStore formatted-report files (review gap #2)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function quickResult(): QuickAnalysisResult {
    return {
      ticker: "600519",
      date: "2026-06-05",
      mode: "quick",
      analysts: [{
        role: "market",
        content: "Strong technical indicators.",
        verdict: { direction: "Buy", reason: "Momentum" },
        data_sources_used: ["market_data"],
      }],
      final: {
        ticker: "600519", company_name: "Kweichow Moutai", date: "2026-06-05",
        direction: "Buy", confidence: 0.85, target_price: 1850.0, stop_loss: 1650.0,
        position_pct: 5.0, reasoning: "Strong brand", key_risks: ["Regulatory"],
        analyst_verdicts: { market: "Buy" }, bull_bear_summary: "",
        risk_assessment: "pass", execution_plan: "Accumulate on dips", next_review_trigger: "",
      },
    };
  }

  it("Should auto-write report.md alongside the JSON artifacts", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-fmt-test-"));
    const store = new ReportStore(tmpDir);
    store.save("600519", "2026-06-05", "quick", quickResult(), 15000, 2500, 0.012);

    const mdPath = path.join(tmpDir, "600519", "2026-06-05_quick", "report.md");
    expect(fs.existsSync(mdPath)).toBe(true);
    const md = fs.readFileSync(mdPath, "utf-8");
    expect(md).toContain("600519");
    expect(md).toContain("买入");  // directionLabel("Buy") = "买入 Buy"
  });

  it("Should auto-write report.html alongside the JSON artifacts", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-fmt-test-"));
    const store = new ReportStore(tmpDir);
    store.save("600519", "2026-06-05", "quick", quickResult(), 15000, 2500, 0.012);

    const htmlPath = path.join(tmpDir, "600519", "2026-06-05_quick", "report.html");
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, "utf-8");
    expect(html).toContain("<html");
    expect(html).toContain("600519");
  });
});

describe("ReportStore.saveFull token/cost (review gap #7)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function fullResult(): FullAnalysisResult {
    return {
      ticker: "600519",
      date: "2026-06-05",
      mode: "full",
      analysts: [{
        role: "market",
        content: "Strong technical indicators.",
        verdict: { direction: "Buy", reason: "Momentum" },
        data_sources_used: ["market_data"],
      }],
      debate: { rounds: [], bull_summary: "", bear_summary: "", total_tokens: 0, total_cost_usd: 0 },
      research_decision: {
        direction: "Overweight", confidence: 0.75, bull_score: 70, bear_score: 40,
        reasoning: "bull wins", key_debate_points: ["政策利好"],
        verdict: { direction: "Overweight", reason: "bull wins" },
      },
      trading_plan: {
        direction: "Buy", target_price: 1400, stop_loss: 1200, position_pct: 25,
        execution_plan: "分批建仓", entry_signals: ["回调到1280"], exit_signals: ["跌破1200"],
        invalidations: ["跌破1200"], key_risks: ["政策风险"], t_plus_1_note: "T+1制度",
      },
      risk_debate: { rounds: [], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
      risk_assessment: { status: "pass", reasoning: "ok", risk_score: 35 },
      final: {
        ticker: "600519", company_name: "Kweichow Moutai", date: "2026-06-05",
        direction: "Buy", confidence: 0.85, target_price: 1850.0, stop_loss: 1650.0,
        position_pct: 5.0, reasoning: "Strong brand", key_risks: ["Regulatory"],
        analyst_verdicts: { market: "Buy" }, bull_bear_summary: "",
        risk_assessment: "pass", execution_plan: "Accumulate on dips", next_review_trigger: "",
      },
    };
  }

  it("Should persist real total_tokens/cost in the full summary (not hardcoded 0)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-full-test-"));
    const store = new ReportStore(tmpDir);

    store.saveFull("600519", "2026-06-05", fullResult(), 15000, 2500, 0.012, "run-x");

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_full.json"), "utf-8")
    );
    expect(summary.total_tokens).toBe(2500);
    expect(summary.total_cost_usd).toBe(0.012);
  });

  it("Should persist full RiskAssessment object in risk_assessment_detail (review gap #4)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-full-test-"));
    const store = new ReportStore(tmpDir);

    const result = fullResult();
    // Add structured judge + retries_exhausted to verify they survive the round-trip
    result.risk_assessment = {
      status: "revise",
      reasoning: "仓位过高",
      risk_score: 72,
      judge: {
        verdict: "revise",
        reason: "仓位超过 30%",
        hard_constraints: ["总仓位≤30%"],
        soft_constraints: ["分批建仓"],
        execution_preconditions: ["开盘不追高"],
        de_risk_triggers: ["跌破 1200 减半仓"],
      },
      retries_exhausted: true,
    };
    result.final.risk_assessment = "revise";

    store.saveFull("600519", "2026-06-05", result, 15000, 2500, 0.012, "run-gap4");

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_full.json"), "utf-8")
    );

    // final.risk_assessment is still the string
    expect(summary.final.risk_assessment).toBe("revise");

    // risk_assessment_detail carries the full object
    expect(summary.risk_assessment_detail).toBeDefined();
    expect(summary.risk_assessment_detail.status).toBe("revise");
    expect(summary.risk_assessment_detail.risk_score).toBe(72);
    expect(summary.risk_assessment_detail.retries_exhausted).toBe(true);
    expect(summary.risk_assessment_detail.judge.hard_constraints).toEqual(["总仓位≤30%"]);
    expect(summary.risk_assessment_detail.judge.de_risk_triggers).toEqual(["跌破 1200 减半仓"]);
  });
});

describe("ReportStore warnings persistence (review gap #2 silent-fallback visibility)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function quickResult(): QuickAnalysisResult {
    return {
      ticker: "600519",
      date: "2026-06-05",
      mode: "quick",
      analysts: [],
      final: {
        ticker: "600519", company_name: "T", date: "2026-06-05",
        direction: "Buy", confidence: 0.7, target_price: 100, stop_loss: 90,
        position_pct: 10, reasoning: "", key_risks: [],
        analyst_verdicts: {}, bull_bear_summary: "",
        risk_assessment: "pass", execution_plan: "", next_review_trigger: "",
      },
    };
  }

  it("save persists fallback warnings into the summary JSON (quick)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-warn-test-"));
    const store = new ReportStore(tmpDir);
    const warnings = [
      { phase: "trader", fn: "parsePositionPct", detail: "回退到减仓总量=30%", severity: "warn" as const },
      { phase: "risk", fn: "runRiskManager", detail: "status 默认 pass", severity: "error" as const },
    ];

    store.save("600519", "2026-06-05", "quick", quickResult(), 15000, 2500, 0.012, "run-w", warnings);

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_quick.json"), "utf-8")
    );
    expect(summary.warnings).toEqual(warnings);
  });

  it("save defaults warnings to [] when none are passed (backward compatible)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-warn-test-"));
    const store = new ReportStore(tmpDir);

    store.save("600519", "2026-06-05", "quick", quickResult(), 15000, 2500, 0.012);

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_quick.json"), "utf-8")
    );
    expect(summary.warnings).toEqual([]);
  });

  it("quick save does NOT set risk_assessment_detail (no risk phase)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-warn-test-"));
    const store = new ReportStore(tmpDir);

    store.save("600519", "2026-06-05", "quick", quickResult(), 15000, 2500, 0.012);

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_quick.json"), "utf-8")
    );
    expect(summary.risk_assessment_detail).toBeUndefined();
  });

  it("saveFull persists cross_stage_issues into the full summary", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-warn-test-"));
    const store = new ReportStore(tmpDir);
    const full: FullAnalysisResult = {
      ticker: "600519", date: "2026-06-05", mode: "full",
      analysts: [],
      debate: { rounds: [], bull_summary: "", bear_summary: "", total_tokens: 0, total_cost_usd: 0 },
      research_decision: { direction: "Buy", confidence: 0.7, bull_score: 70, bear_score: 40, reasoning: "", key_debate_points: [], verdict: { direction: "Buy", reason: "" } },
      trading_plan: { direction: "Buy", target_price: 0, stop_loss: 0, position_pct: 0, execution_plan: "", entry_signals: [], exit_signals: [], invalidations: [], key_risks: [], t_plus_1_note: "" },
      risk_debate: { rounds: [], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
      risk_assessment: { status: "pass", reasoning: "", risk_score: 50 },
      final: { ticker: "600519", company_name: "T", date: "2026-06-05", direction: "Buy", confidence: 0.7, target_price: 0, stop_loss: 0, position_pct: 0, reasoning: "", key_risks: [], analyst_verdicts: {}, bull_bear_summary: "", risk_assessment: "pass", execution_plan: "", next_review_trigger: "" },
    };
    const issues = [
      { severity: "warn" as const, check: "consensus_conflict", message: "分析师看空但研究 Buy" },
    ];

    store.saveFull("600519", "2026-06-05", full, 15000, 2500, 0.012, "run-c", [], issues);

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_full.json"), "utf-8")
    );
    expect(summary.cross_stage_issues).toEqual(issues);
  });
});

describe("ReportStore provenance chain (review gap #5)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("save persists quick-mode provenance chain in summary JSON", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-prov-test-"));
    const store = new ReportStore(tmpDir);
    const result: QuickAnalysisResult = {
      ticker: "600519", date: "2026-06-05", mode: "quick",
      analysts: [
        { role: "market", content: "bullish", verdict: { direction: "看多", reason: "momentum" }, data_sources_used: ["market_data"] },
        { role: "fundamentals", content: "strong", verdict: { direction: "看多", reason: "earnings" }, data_sources_used: ["fundamentals_data"] },
        { role: "news", content: "neutral", verdict: { direction: "中性", reason: "mixed" }, data_sources_used: ["news_data"] },
      ],
      final: {
        ticker: "600519", company_name: "Moutai", date: "2026-06-05",
        direction: "Buy", confidence: 0.8, target_price: 1800, stop_loss: 1600,
        position_pct: 10, reasoning: "看多分析师占多数", key_risks: [],
        analyst_verdicts: { market: "看多", fundamentals: "看多", news: "中性" },
        bull_bear_summary: "", risk_assessment: "pass", execution_plan: "", next_review_trigger: "",
      },
    };

    const provenance = [
      { stage: "analysts", key_decision: "2看多/0看空/1中性", detail_ref: "01_analysts/" },
      { stage: "portfolio_manager", key_decision: "Buy (80%)" },
    ];

    store.save("600519", "2026-06-05", "quick", result, 5000, 1000, 0.01, "run-prov", [], [], provenance);

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_quick.json"), "utf-8")
    );
    expect(summary.provenance).toHaveLength(2);
    expect(summary.provenance[0].stage).toBe("analysts");
    expect(summary.provenance[0].key_decision).toBe("2看多/0看空/1中性");
    expect(summary.provenance[0].detail_ref).toBe("01_analysts/");
    expect(summary.provenance[1].stage).toBe("portfolio_manager");
    expect(summary.provenance[1].key_decision).toBe("Buy (80%)");
  });

  it("saveFull persists full-mode provenance chain in summary JSON", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-prov-test-"));
    const store = new ReportStore(tmpDir);

    const full: FullAnalysisResult = {
      ticker: "600519", date: "2026-06-05", mode: "full",
      analysts: [
        { role: "market", content: "bullish", verdict: { direction: "看多", reason: "m" }, data_sources_used: ["market_data"] },
      ],
      debate: { rounds: [], bull_summary: "growth", bear_summary: "risk", total_tokens: 0, total_cost_usd: 0 },
      research_decision: { direction: "Overweight", confidence: 0.75, bull_score: 70, bear_score: 40, reasoning: "bull wins", key_debate_points: ["政策利好"], verdict: { direction: "Overweight", reason: "bull" } },
      trading_plan: { direction: "Buy", target_price: 1400, stop_loss: 1200, position_pct: 25, execution_plan: "分批建仓", entry_signals: ["回调到1280"], exit_signals: ["跌破1200"], invalidations: [], key_risks: [], t_plus_1_note: "" },
      risk_debate: { rounds: [], risk_arguments: [], total_tokens: 0, total_cost_usd: 0 },
      risk_assessment: { status: "pass", reasoning: "ok", risk_score: 35 },
      final: { ticker: "600519", company_name: "T", date: "2026-06-05", direction: "Buy", confidence: 0.75, target_price: 1400, stop_loss: 1200, position_pct: 25, reasoning: "", key_risks: [], analyst_verdicts: {}, bull_bear_summary: "", risk_assessment: "pass", execution_plan: "", next_review_trigger: "" },
    };

    const provenance = [
      { stage: "analysts", key_decision: "1看多/0看空/0中性", detail_ref: "01_analysts/" },
      { stage: "debate", key_decision: "Bull 70 vs Bear 40", detail_ref: "02_debate/" },
      { stage: "research", key_decision: "Overweight (75%)", detail_ref: "03_research.json" },
      { stage: "trader", key_decision: "Buy target=1400 stop=1200 pos=25%", detail_ref: "04_trading_plan.json" },
      { stage: "risk", key_decision: "pass (35/100)", detail_ref: "05_risk/" },
    ];

    store.saveFull("600519", "2026-06-05", full, 15000, 2500, 0.012, "run-prov", [], [], [], provenance);

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_full.json"), "utf-8")
    );
    expect(summary.provenance).toHaveLength(5);
    expect(summary.provenance[0].stage).toBe("analysts");
    expect(summary.provenance[2].stage).toBe("research");
    expect(summary.provenance[2].detail_ref).toBe("03_research.json");
    expect(summary.provenance[4].key_decision).toBe("pass (35/100)");
  });

  it("save defaults provenance to [] when not passed (backward compatible)", () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "report-prov-test-"));
    const store = new ReportStore(tmpDir);
    const result: QuickAnalysisResult = {
      ticker: "600519", date: "2026-06-05", mode: "quick",
      analysts: [],
      final: {
        ticker: "600519", company_name: "T", date: "2026-06-05",
        direction: "Hold", confidence: 0.5, target_price: 0, stop_loss: 0,
        position_pct: 0, reasoning: "", key_risks: [], analyst_verdicts: {},
        bull_bear_summary: "", risk_assessment: "pass", execution_plan: "", next_review_trigger: "",
      },
    };

    store.save("600519", "2026-06-05", "quick", result, 1000, 0, 0);

    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "600519", "2026-06-05_quick.json"), "utf-8")
    );
    expect(summary.provenance).toEqual([]);
  });
});
