"use strict";
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
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
const PROJECT_ROOT = path.resolve(__dirname, "..");
function resolvePython() {
    return process.env.TRADING_PYTHON || "python3";
}
function runPython(script, extraArgs, watchlistDir) {
    const scriptPath = path.join(PROJECT_ROOT, "skills", "watchlist", "scripts", script);
    const args = [scriptPath, "--watchlist-dir", watchlistDir, ...extraArgs];
    console.log(`\n\u25b6 python ${script} ${extraArgs.join(" ")}`);
    (0, child_process_1.execFileSync)(resolvePython(), args, { stdio: "inherit", env: process.env });
}
function runNode(script, extraArgs, watchlistDir) {
    const scriptPath = path.join(PROJECT_ROOT, "dist", script);
    if (!fs.existsSync(scriptPath)) {
        console.error(`error: ${scriptPath} 不存在，请先 npm run build`);
        process.exit(1);
    }
    const args = [scriptPath, ...extraArgs];
    console.log(`\n\u25b6 node ${script} ${extraArgs.join(" ")}`);
    (0, child_process_1.execFileSync)("node", args, {
        stdio: "inherit",
        env: { ...process.env, WATCHLIST_DIR: watchlistDir },
    });
}
function main() {
    const args = process.argv.slice(2);
    const help = args.includes("--help") || args.includes("-h");
    const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;
    const dateIdx = args.indexOf("--date");
    const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : new Date().toISOString().split("T")[0];
    const concIdx = args.indexOf("--concurrency");
    const concurrency = concIdx >= 0 && args[concIdx + 1] ? args[concIdx + 1] : "3";
    if (help) {
        console.log(`Usage: npm run scan-all [-- --date <D> --concurrency <N>]

串跑全流程：universe → snapshot → diff → candidates
  --date <D>          扫描日（默认今天）
  --concurrency <N>   snapshot 并发（默认 3）
  WATCHLIST_DIR       存储路径（默认 ${DEFAULT_WATCHLIST_DIR}）
`);
        process.exit(0);
    }
    runPython("scan_universe.py", [], watchlistDir);
    runPython("snapshot.py", ["--date", date, "--concurrency", concurrency], watchlistDir);
    runNode("diff-cli.js", [], watchlistDir); // 默认最新快照
    runNode("candidates-cli.js", [], watchlistDir); // 默认最新 diff
    console.log(`\n\u2713 全流程完成: ${date}`);
    console.log(`  候选清单: ${path.join(watchlistDir, "derived", `${date}-candidates.json`)}`);
}
main();
//# sourceMappingURL=scan-all-cli.js.map