// src/llm-bench-cli.ts
//
// LLM bench 对比工具 CLI：读 bench 配置 → 回放 watchlist trace → 写 report.md + results.json
//
// Usage:
//   npm run bench -- --config bench/thinking-on-off.json
//   npm run bench -- --config bench/x.json --dry-run
//   npm run bench -- --config bench/x.json --watchlist-dir /path/to/watchlist

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { runBench } from "./watchlist/bench-runner";
import type { BenchConfig } from "./watchlist/bench-types";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function argValue(args: string[], key: string): string | undefined {
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

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as BenchConfig;

  try {
    const outDir = await runBench(config, configPath, watchlistDir, dryRun);
    if (!outDir && !dryRun) process.exit(1);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

if (require.main === module) main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
