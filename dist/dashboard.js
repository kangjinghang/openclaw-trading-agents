"use strict";
// src/dashboard.ts — Dashboard HTTP server + CLI entry point
//
// Usage:
//   node dist/dashboard.js
//   node dist/dashboard.js --port 3210
//   node dist/dashboard.js --report-dir ./trading-reports
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
exports.parseDashboardArgs = parseDashboardArgs;
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const dashboard_api_1 = require("./dashboard-api");
const DEFAULT_PORT = 3210;
/** Resolve report directory: explicit > local ./trading-reports > ~/.openclaw/trading-reports */
function resolveReportDir(explicit) {
    if (explicit)
        return explicit;
    // Prefer local ./trading-reports if it exists
    const localDir = path.resolve(process.cwd(), "trading-reports");
    if (fs.existsSync(localDir))
        return localDir;
    const homeDir = path.join(os.homedir(), ".openclaw", "trading-reports");
    if (fs.existsSync(homeDir))
        return homeDir;
    // Fallback to local dir (will show empty dashboard)
    return localDir;
}
function parseDashboardArgs(argv) {
    let port = DEFAULT_PORT;
    let explicitDir;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--port" && argv[i + 1]) {
            port = parseInt(argv[++i], 10);
        }
        else if (argv[i] === "--report-dir" && argv[i + 1]) {
            explicitDir = argv[++i];
        }
        else if (argv[i] === "--help" || argv[i] === "-h") {
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
function startServer(reportDir, port) {
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
            handleJson(res, (0, dashboard_api_1.listReports)(absReportDir));
            return;
        }
        // GET /api/report/:ticker/:file  (e.g. /api/report/600519/2026-06-05_quick.json)
        const reportMatch = pathname.match(/^\/api\/report\/([^/]+)\/(.+\.json)$/);
        if (reportMatch) {
            const [, ticker, file] = reportMatch;
            const data = (0, dashboard_api_1.readReport)(absReportDir, ticker, file.replace(".json", ""));
            if (data) {
                handleJson(res, data);
            }
            else {
                handleNotFound(res);
            }
            return;
        }
        // GET /api/detail/:ticker/:dateMode/:subPath
        const detailMatch = pathname.match(/^\/api\/detail\/([^/]+)\/([^/]+)\/(.+)$/);
        if (detailMatch) {
            const [, ticker, dateMode, subPath] = detailMatch;
            const data = (0, dashboard_api_1.readDetail)(absReportDir, ticker, dateMode, subPath);
            if (data) {
                handleJson(res, data);
            }
            else {
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
                handleJson(res, (0, dashboard_api_1.readTraces)(absReportDir, runId));
            }
            else if (ticker && date) {
                handleJson(res, (0, dashboard_api_1.readTracesByTickerDate)(absReportDir, ticker, date));
            }
            else {
                handleJson(res, []);
            }
            return;
        }
        // GET /api/data/:ticker/:dateMode  (e.g. /api/data/600519/2026-06-05_quick)
        const dataMatch = pathname.match(/^\/api\/data\/([^/]+)\/(.+)$/);
        if (dataMatch) {
            const [, ticker, dateMode] = dataMatch;
            handleJson(res, (0, dashboard_api_1.readDataSources)(absReportDir, ticker, dateMode));
            return;
        }
        // GET /api/source-health — cross-run per-source call stats
        if (pathname === "/api/source-health") {
            handleJson(res, (0, dashboard_api_1.readSourceHealth)(absReportDir) ?? {
                version: 1,
                updated_at: "",
                sources: {},
            });
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
function handleJson(res, data) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}
function handleNotFound(res) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
}
function serveStatic(res, filePath, contentType) {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" });
        res.end(content);
    }
    catch {
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
//# sourceMappingURL=dashboard.js.map