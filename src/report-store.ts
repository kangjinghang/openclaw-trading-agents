import * as fs from "fs";
import * as path from "path";
import { QuickAnalysisResult, FullAnalysisResult, AnalysisReport } from "./types";

export class ReportStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
  }

  /** Write JSON to file atomically (write .tmp then rename), logging errors instead of crashing */
  private writeJson(filePath: string, data: unknown): void {
    const tmpPath = filePath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.error(`[ReportStore] Failed to write ${filePath}: ${err instanceof Error ? err.message : err}`);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    }
  }

  /** Create directory, logging errors instead of crashing */
  private mkdir(dirPath: string): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (err) {
      console.error(`[ReportStore] Failed to create directory ${dirPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Save a quick analysis result to disk.
   * Creates: {baseDir}/{ticker}/{date}_quick.json (summary)
   *           {baseDir}/{ticker}/{date}_quick/01_analysts/*.json (details)
   */
  save(
    ticker: string,
    date: string,
    mode: "quick" | "full",
    result: QuickAnalysisResult,
    durationMs: number,
    totalTokens: number,
    totalCostUsd: number,
    runId?: string
  ): void {
    const tickerDir = path.join(this.baseDir, ticker);
    const detailDir = path.join(tickerDir, `${date}_${mode}`);
    this.mkdir(tickerDir);
    this.mkdir(path.join(detailDir, "01_analysts"));

    // Save analyst details
    for (const report of result.analysts) {
      this.writeJson(path.join(detailDir, "01_analysts", `${report.role}.json`), report);
    }

    // Save summary
    const analystVerdicts: Record<string, { direction: string; reason: string }> = {};
    for (const report of result.analysts) {
      analystVerdicts[report.role] = report.verdict;
    }

    const summary: AnalysisReport = {
      id: `${ticker}_${date}_${mode}`,
      run_id: runId,
      ticker,
      company_name: result.final.company_name,
      date,
      mode,
      created_at: new Date().toISOString(),
      duration_ms: durationMs,
      total_tokens: totalTokens,
      total_cost_usd: totalCostUsd,
      final: result.final,
      analyst_verdicts: analystVerdicts,
      detail_dir: `${date}_${mode}/`,
      trace_count: result.analysts.length + 1,
    };

    this.writeJson(path.join(tickerDir, `${date}_${mode}.json`), summary);
  }

  /**
   * Save a full analysis result to disk with structured directory layout.
   */
  saveFull(
    ticker: string,
    date: string,
    result: FullAnalysisResult,
    durationMs: number,
    runId?: string
  ): void {
    const tickerDir = path.join(this.baseDir, ticker);
    const detailDir = path.join(tickerDir, `${date}_full`);
    this.mkdir(path.join(detailDir, "01_analysts"));
    this.mkdir(path.join(detailDir, "02_debate"));
    this.mkdir(path.join(detailDir, "05_risk"));

    // 01_analysts
    for (const report of result.analysts) {
      this.writeJson(path.join(detailDir, "01_analysts", `${report.role}.json`), report);
    }

    // 02_debate
    for (const round of result.debate.rounds) {
      this.writeJson(path.join(detailDir, "02_debate", `round_${round.round}.json`), round);
    }

    // 03_research
    this.writeJson(path.join(detailDir, "03_research.json"), result.research_decision);

    // 04_trading_plan
    this.writeJson(path.join(detailDir, "04_trading_plan.json"), result.trading_plan);

    // 05_risk
    this.writeJson(path.join(detailDir, "05_risk", "risk_debate.json"), result.risk_debate);
    this.writeJson(path.join(detailDir, "05_risk", "risk_manager.json"), result.risk_assessment);

    // Summary
    const analystVerdicts: Record<string, { direction: string; reason: string }> = {};
    for (const report of result.analysts) {
      analystVerdicts[report.role] = report.verdict;
    }

    const summary: AnalysisReport = {
      id: `${ticker}_${date}_full`,
      run_id: runId,
      ticker,
      company_name: result.final.company_name,
      date,
      mode: "full",
      created_at: new Date().toISOString(),
      duration_ms: durationMs,
      total_tokens: 0,
      total_cost_usd: 0,
      final: result.final,
      analyst_verdicts: analystVerdicts,
      detail_dir: `${date}_full/`,
      trace_count: result.analysts.length + 4 + 1 + 1 + 3 + 1,
    };

    this.writeJson(path.join(tickerDir, `${date}_full.json`), summary);
  }
}
