import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as fs from "fs";
import { resolvePythonCmd } from "./exec-python";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
const PROJECT_ROOT = path.resolve(__dirname, "..");

function runPython(script: string, extraArgs: string[], watchlistDir: string) {
  const scriptPath = path.join(PROJECT_ROOT, "skills", "watchlist", "scripts", script);
  const args = [scriptPath, "--watchlist-dir", watchlistDir, ...extraArgs];
  console.log(`\n\u25b6 python ${script} ${extraArgs.join(" ")}`);
  execFileSync(resolvePythonCmd(), args, { stdio: "inherit", env: process.env });
}

function runNode(script: string, extraArgs: string[], watchlistDir: string) {
  const scriptPath = path.join(PROJECT_ROOT, "dist", script);
  if (!fs.existsSync(scriptPath)) {
    console.error(`error: ${scriptPath} 不存在，请先 npm run build`);
    process.exit(1);
  }
  const args = [scriptPath, ...extraArgs];
  console.log(`\n\u25b6 node ${script} ${extraArgs.join(" ")}`);
  execFileSync("node", args, {
    stdio: "inherit",
    env: { ...process.env, WATCHLIST_DIR: watchlistDir },
  });
}

function main() {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;

  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
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
  runNode("diff-cli.js", [], watchlistDir);          // 默认最新快照
  runNode("candidates-cli.js", [], watchlistDir);    // 默认最新 diff

  console.log(`\n\u2713 全流程完成: ${date}`);
  console.log(`  候选清单: ${path.join(watchlistDir, "derived", `${date}-candidates.json`)}`);
}

main();
