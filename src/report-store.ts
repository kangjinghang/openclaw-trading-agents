import * as fs from "fs";
import * as path from "path";
import { QuickAnalysisResult, AnalysisReport } from "./types";

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

    // Save analyst detail
    const analystPath = path.join(detailDir, "01_analysts", `${result.analyst.role}.json`);
    fs.writeFileSync(analystPath, JSON.stringify(result.analyst, null, 2), "utf-8");

    // Save summary
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
      analyst_verdicts: { [result.analyst.role]: result.analyst.verdict },
      detail_dir: `${date}_${mode}/`,
      trace_count: 2,
    };

    const summaryPath = path.join(tickerDir, `${date}_${mode}.json`);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
  }
}
