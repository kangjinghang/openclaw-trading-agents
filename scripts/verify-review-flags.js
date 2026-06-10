// scripts/verify-review-flags.js — verify ②warnings + ③cross_stage landed in a run
// Usage: node scripts/verify-review-flags.js <ticker> <dateModeJson>
//   e.g. node scripts/verify-review-flags.js 600315 trading-reports/600315/2026-06-10_full.json
const fs = require("fs");
const path = require("path");

const jsonPath = process.argv[3] || (() => {
  const ticker = process.argv[2];
  const dir = path.join("trading-reports", ticker);
  const cands = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith("_full.json")).sort().reverse() : [];
  if (!cands.length) { console.error("no _full.json summary found under", dir); process.exit(1); }
  return path.join(dir, cands[0]);
})();

const s = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
const warns = s.warnings || [];
const issues = s.cross_stage_issues || [];

console.log("summary:", path.relative(process.cwd(), jsonPath));
console.log("run_id:", s.run_id);
console.log("direction:", s.final?.direction, " risk:", s.final?.risk_assessment, " pos:", s.final?.position_pct);
console.log("target/stop:", s.final?.target_price, "/", s.final?.stop_loss);
console.log("\n② warnings (" + warns.length + "):");
for (const w of warns) console.log(`  [${w.severity}] ${w.phase}.${w.fn}: ${w.detail}`);
console.log("\n③ cross_stage_issues (" + issues.length + "):");
for (const i of issues) console.log(`  [${i.severity}] ${i.check}: ${i.message}`);

// run_summary.json in the isolated trace dir
const traceBase = path.join(path.dirname(jsonPath), path.basename(jsonPath, ".json"), "06_traces");
if (fs.existsSync(traceBase)) {
  const runDirs = fs.readdirSync(traceBase).filter(d => fs.statSync(path.join(traceBase, d)).isDirectory());
  for (const rd of runDirs) {
    const rs = path.join(traceBase, rd, "run_summary.json");
    if (fs.existsSync(rs)) {
      const m = JSON.parse(fs.readFileSync(rs, "utf-8"));
      console.log("\nrun_summary.json:", path.relative(process.cwd(), rs));
      console.log("  warnings in run_summary:", (m.warnings || []).length);
    }
  }
}
