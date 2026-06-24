"use strict";
// src/llm-bench-cli.ts
//
// LLM bench 对比工具 CLI：读 bench 配置 → 回放 watchlist trace → 写 report.md + results.json
//
// Usage:
//   npm run bench -- --config bench/thinking-on-off.json
//   npm run bench -- --config bench/x.json --dry-run
//   npm run bench -- --config bench/x.json --watchlist-dir /path/to/watchlist
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
const fs = __importStar(require("fs"));
const bench_runner_1 = require("./watchlist/bench-runner");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
function argValue(args, key) {
    const idx = args.indexOf(key);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
async function main() {
    const args = process.argv.slice(2);
    const configPath = argValue(args, "--config");
    const watchlistDir = argValue(args, "--watchlist-dir") ?? process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;
    const dryRun = args.includes("--dry-run");
    if (!configPath || args.includes("--help") || args.includes("-h")) {
        console.log(`Usage: npm run bench -- --config <bench.json> [--dry-run] [--watchlist-dir <dir>]

读 bench 配置 → 回放 watchlist rank/rebalance trace → 写 report.md + results.json

Options:
  --config <path>        必填，bench 配置文件（见 bench/*.json）
  --dry-run              只列出选中 trace 和调用数，不调 LLM
  --watchlist-dir <dir>  watchlist 根目录（默认 ${DEFAULT_WATCHLIST_DIR}）
  --help                 显示本帮助
`);
        process.exit(configPath ? 0 : 1);
    }
    if (!fs.existsSync(configPath)) {
        console.error(`error: 配置文件不存在: ${configPath}`);
        process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    try {
        const outDir = await (0, bench_runner_1.runBench)(config, configPath, watchlistDir, dryRun);
        if (!outDir && !dryRun)
            process.exit(1);
    }
    catch (e) {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}
if (require.main === module)
    main().catch((e) => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
//# sourceMappingURL=llm-bench-cli.js.map