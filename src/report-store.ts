import * as fs from "fs";
import * as path from "path";
import { QuickAnalysisResult, FullAnalysisResult, AnalysisReport } from "./types";

export class ReportStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
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
    totalCostUsd: number
  ): void {
    const tickerDir = path.join(this.baseDir, ticker);
    const detailDir = path.join(tickerDir, `${date}_${mode}`);
    fs.mkdirSync(tickerDir, { recursive: true });
    fs.mkdirSync(path.join(detailDir, "01_analysts"), { recursive: true });

    // Save analyst details
    for (const report of result.analysts) {
      const analystPath = path.join(detailDir, "01_analysts", `${report.role}.json`);
      fs.writeFileSync(analystPath, JSON.stringify(report, null, 2), "utf-8");
    }

    // Save summary
    const analystVerdicts: Record<string, { direction: string; reason: string }> = {};
    for (const report of result.analysts) {
      analystVerdicts[report.role] = report.verdict;
    }

    const summary: AnalysisReport = {
      id: `${ticker}_${date}_${mode}`,
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

    const summaryPath = path.join(tickerDir, `${date}_${mode}.json`);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
  }

  /**
   * Save a full analysis result to disk with structured directory layout.
   */
  saveFull(
    ticker: string,
    date: string,
    result: FullAnalysisResult,
    durationMs: number
  ): void {
    const tickerDir = path.join(this.baseDir, ticker);
    const detailDir = path.join(tickerDir, `${date}_full`);
    fs.mkdirSync(path.join(detailDir, "01_analysts"), { recursive: true });
    fs.mkdirSync(path.join(detailDir, "02_debate"), { recursive: true });
    fs.mkdirSync(path.join(detailDir, "05_risk"), { recursive: true });

    // 01_analysts
    for (const report of result.analysts) {
      fs.writeFileSync(
        path.join(detailDir, "01_analysts", `${report.role}.json`),
        JSON.stringify(report, null, 2), "utf-8"
      );
    }

    // 02_debate
    for (const round of result.debate.rounds) {
      fs.writeFileSync(
        path.join(detailDir, "02_debate", `round_${round.round}.json`),
        JSON.stringify(round, null, 2), "utf-8"
      );
    }

    // 03_research
    fs.writeFileSync(
      path.join(detailDir, "03_research.json"),
      JSON.stringify(result.research_decision, null, 2), "utf-8"
    );

    // 04_trading_plan
    fs.writeFileSync(
      path.join(detailDir, "04_trading_plan.json"),
      JSON.stringify(result.trading_plan, null, 2), "utf-8"
    );

    // 05_risk
    fs.writeFileSync(
      path.join(detailDir, "05_risk", "risk_debate.json"),
      JSON.stringify(result.risk_debate, null, 2), "utf-8"
    );
    fs.writeFileSync(
      path.join(detailDir, "05_risk", "risk_manager.json"),
      JSON.stringify(result.risk_assessment, null, 2), "utf-8"
    );

    // Summary
    const analystVerdicts: Record<string, { direction: string; reason: string }> = {};
    for (const report of result.analysts) {
      analystVerdicts[report.role] = report.verdict;
    }

    const summary: AnalysisReport = {
      id: `${ticker}_${date}_full`,
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

    fs.writeFileSync(
      path.join(tickerDir, `${date}_full.json`),
      JSON.stringify(summary, null, 2), "utf-8"
    );
  }
}
