// src/watchlist/holdings-loader.ts
import * as fs from "fs";
import type { Holdings } from "./rebalance-types";

export interface ValidationResult { ok: boolean; error: string | null; }

/** 校验 holdings schema + 权重和。 */
export function validateHoldings(h: Holdings): ValidationResult {
  if (!Array.isArray(h.positions)) return { ok: false, error: "positions 必须是数组" };
  if (typeof h.cash_pct !== "number" || h.cash_pct < 0 || h.cash_pct > 1) {
    return { ok: false, error: `cash_pct ${h.cash_pct} 不在 [0,1]` };
  }
  for (const p of h.positions) {
    if (!p.sector || !p.sector.trim()) {
      return { ok: false, error: `${p.ticker} 缺 sector 字段` };
    }
    if (!p.entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(p.entry_date)) {
      return { ok: false, error: `${p.ticker} entry_date 格式错误: ${p.entry_date}` };
    }
  }
  const sum = h.positions.reduce((s, p) => s + p.weight, 0) + h.cash_pct;
  if (Math.abs(sum - 1.0) > 0.001) {
    return { ok: false, error: `权重和 ${sum.toFixed(3)} 不等于 1.0（positions + cash）` };
  }
  return { ok: true, error: null };
}

/** 计算某 entry_date 在 currentDate 下是否被 anti-churn 锁定。
 *  antiChurnDays=0 表示永不锁定。格式错误也返回 false（防御性）。 */
export function computeLocked(entryDate: string, currentDate: string, antiChurnDays: number): boolean {
  if (antiChurnDays <= 0) return false;
  const entry = new Date(entryDate + "T00:00:00+08:00").getTime();
  const current = new Date(currentDate + "T00:00:00+08:00").getTime();
  if (isNaN(entry) || isNaN(current)) return false;
  const daysHeld = Math.floor((current - entry) / (24 * 60 * 60 * 1000));
  return daysHeld < antiChurnDays;
}

/** 读 holdings.json 文件 + 校验。文件不存在或校验失败抛错。 */
export function loadHoldings(filePath: string): Holdings {
  if (!fs.existsSync(filePath)) {
    throw new Error(`holdings.json 不存在: ${filePath}\n请手动创建，schema 见 rebalance-types.ts:Holdings`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Holdings;
  const v = validateHoldings(raw);
  if (!v.ok) throw new Error(`holdings.json 校验失败: ${v.error}`);
  return raw;
}
