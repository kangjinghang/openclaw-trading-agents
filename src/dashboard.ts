// src/dashboard.ts — Dashboard HTTP server + CLI entry point
//
// Usage:
//   node dist/dashboard.js
//   node dist/dashboard.js --port 3210
//   node dist/dashboard.js --report-dir ./trading-reports

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listReports, readReport, readDetail, readTraces, readTracesByTickerDate } from "./dashboard-api";

const DEFAULT_PORT = 3210;

/** Resolve report directory: explicit > local ./trading-reports > ~/.openclaw/trading-reports */
function resolveReportDir(explicit?: string): string {
  if (explicit) return explicit;

  // Prefer local ./trading-reports if it exists
  const localDir = path.resolve(process.cwd(), "trading-reports");
  if (fs.existsSync(localDir)) return localDir;

  const homeDir = path.join(os.homedir(), ".openclaw", "trading-reports");
  if (fs.existsSync(homeDir)) return homeDir;

  // Fallback to local dir (will show empty dashboard)
  return localDir;
}

function parseDashboardArgs(argv: string[]): { port: number; reportDir: string } {
  let port = DEFAULT_PORT;
  let explicitDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
    } else if (argv[i] === "--report-dir" && argv[i + 1]) {
      explicitDir = argv[++i];
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`
OpenClaw Trading Agents — Dashboard

Usage:
  node dist/dashboard.js [options]

Options:
  --port <n>           HTTP port (default: ${DEFAULT_PORT})
  --report-dir <path>  Report directory (auto-detected if omitted)
`);
      process.exit(0);
    }
  }

  return { port, reportDir: resolveReportDir(explicitDir) };
}

/** Serve the dashboard */
export function startServer(reportDir: string, port: number): http.Server {
  const absReportDir = reportDir.replace("~", os.homedir());
  const dashboardDir = path.resolve(__dirname, "../dashboard");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (pathname === "/api/reports") {
      handleJson(res, listReports(absReportDir));
      return;
    }

    // GET /api/report/:ticker/:file  (e.g. /api/report/600519/2026-06-05_quick.json)
    const reportMatch = pathname.match(/^\/api\/report\/([^/]+)\/(.+\.json)$/);
    if (reportMatch) {
      const [, ticker, file] = reportMatch;
      const data = readReport(absReportDir, ticker, file.replace(".json", ""));
      if (data) {
        handleJson(res, data);
      } else {
        handleNotFound(res);
      }
      return;
    }

    // GET /api/detail/:ticker/:dateMode/:subPath
    const detailMatch = pathname.match(/^\/api\/detail\/([^/]+)\/([^/]+)\/(.+)$/);
    if (detailMatch) {
      const [, ticker, dateMode, subPath] = detailMatch;
      const data = readDetail(absReportDir, ticker, dateMode, subPath);
      if (data) {
        handleJson(res, data);
      } else {
        handleNotFound(res);
      }
      return;
    }

    // GET /api/traces?run_id=xxx or ?ticker=xxx&date=xxx
    if (pathname === "/api/traces") {
      const runId = url.searchParams.get("run_id");
      const ticker = url.searchParams.get("ticker");
      const date = url.searchParams.get("date");

      if (runId) {
        handleJson(res, readTraces(runId));
      } else if (ticker && date) {
        handleJson(res, readTracesByTickerDate(ticker, date));
      } else {
        handleJson(res, []);
      }
      return;
    }

    // Static files: serve dashboard/index.html and embedded assets
    if (pathname === "/" || pathname === "/index.html") {
      serveStatic(res, path.join(dashboardDir, "index.html"), "text/html");
      return;
    }

    handleNotFound(res);
  });

  return server;
}

function handleJson(res: http.ServerResponse, data: any): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function handleNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

function serveStatic(res: http.ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    res.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" });
    res.end(content);
  } catch {
    handleNotFound(res);
  }
}

// ── CLI entry ──
if (require.main === module) {
  const { port, reportDir } = parseDashboardArgs(process.argv.slice(2));
  const server = startServer(reportDir, port);

  server.listen(port, () => {
    console.error(`\n  OpenClaw Trading Agents — Dashboard`);
    console.error(`  http://localhost:${port}`);
    console.error(`  Reports: ${reportDir}\n`);
  });
}

export { parseDashboardArgs };
