// src/watchlist/fitness-backfiller.ts
//
// Fitness 历史的懒结算器：rebalance 启动时调用一次，回填到期 open 记录的
// 事后收益（7/14/30 天涨跌幅）。
//
// 为什么是"懒结算"而非 cron：当前无调度器，rebalancer 跑完就退出，无法在
// "7 天后"自动触发。改为每次 rebalance 启动时扫 open 记录，把距 decision_date
// ≥30 天的（覆盖 7/14/30 三窗口）结算掉。代价：首次买入后要等到下次跑
// rebalance 才结算——可接受（回测看的是月度趋势，不差几天）。
//
// 事后价格：复用 kline.py（不接新源）。拉最近 60 根日 K，在 data[] 里按
// date 找 decision_date / +7d / +14d / +30d 的收盘价算涨跌幅。
// 全程容错：kline 失败/找不到某日 → 该 return 留 undefined（部分结算）。
// 绝不阻塞 rebalance 主流程（调用方包 try/catch）。

import * as path from "path";
import { execSkillScript } from "../exec-python";
import type { FitnessHistoryStore, FitnessRecord } from "./fitness-history-store";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** 结算结果（供 rebalance-cli 打日志）。 */
export interface BackfillResult {
  settled: number;   // 本次结算的记录数
  skipped: number;   // 未到期（<30 天）跳过的
  failed: number;    // 到期但结算失败（kline 拉不到价）的
}

/**
 * 懒结算所有到期 open 记录。在 rebalance-cli 主流程开头调用。
 *
 * 判定到期：距 decision_date ≥30 天（这样 7/14/30 三窗口都过了，一次结算全算）。
 * 不到 30 天的跳过（下次再算）。
 *
 * 返回统计。永不抛——调用方仍应包 try/catch 做双保险。
 */
export async function backfillReturns(
  store: FitnessHistoryStore,
  currentDate: string,
): Promise<BackfillResult> {
  const open = store.getOpenRecords();
  if (open.length === 0) return { settled: 0, skipped: 0, failed: 0 };

  const result: BackfillResult = { settled: 0, skipped: 0, failed: 0 };
  const currentMs = Date.parse(currentDate);

  for (const rec of open) {
    const decisionMs = Date.parse(rec.decision_date);
    if (Number.isNaN(decisionMs) || Number.isNaN(currentMs)) {
      result.failed++;
      continue;
    }
    const daysSince = Math.round((currentMs - decisionMs) / 86_400_000);

    // 不到 30 天：7/14/30 三窗口没全过，下次再算
    if (daysSince < 30) {
      result.skipped++;
      continue;
    }

    // 到期：拉 kline 算收益（entry_price 也从 kline 重拉 decision_date 当日收盘价）
    const emptyReturns: { return_7d?: number; return_14d?: number; return_30d?: number } = {};
    const returns = await computeReturns(rec).catch(() => emptyReturns);
    store.settleRecord(rec.decision_date, rec.ticker, returns);
    if (returns.return_7d !== undefined || returns.return_14d !== undefined || returns.return_30d !== undefined) {
      result.settled++;
    } else {
      result.failed++;
    }
  }

  return result;
}

/**
 * 拉单只股的 kline，算 decision_date 后 7/14/30 天的涨跌幅。
 * 复用 execSkillScript 调 kline.py（--count 60 覆盖 30 天窗口）。
 * entry_price 从 decision_date 当日收盘价取（和 7/14/30 价同源）。
 * 失败/找不到某日价格 → 该窗口留 undefined（部分结算）。
 */
async function computeReturns(
  rec: FitnessRecord,
): Promise<{ return_7d?: number; return_14d?: number; return_30d?: number }> {
  const result: { return_7d?: number; return_14d?: number; return_30d?: number } = {};
  let raw: any;
  try {
    const res = await execSkillScript("trading-kline", "kline", PROJECT_ROOT, [rec.ticker, "--count", "60"]);
    if (!res?.success) return result;
    raw = res.data;
  } catch {
    return result;
  }

  // kline.py 输出 data[] 每条带 date(YYYY-MM-DD) + close
  const bars: Array<{ date: string; close: number }> = Array.isArray(raw?.data) ? raw.data : [];
  if (bars.length === 0) return result;

  const findCloseOnOrAfter = (targetDate: string): number | undefined => {
    // 找 >= targetDate 的第一根 K（targetDate 当天或之后的最近交易日）
    for (const b of bars) {
      if (typeof b.close === "number" && b.close > 0 && b.date && b.date.slice(0, 10) >= targetDate) {
        return b.close;
      }
    }
    return undefined;
  };

  // entry_price：优先用记录里已有的（非0），否则从 kline 重拉 decision_date 当日收盘价
  const entry = rec.entry_price > 0
    ? rec.entry_price
    : findCloseOnOrAfter(rec.decision_date);
  if (entry === undefined || entry <= 0) return result;  // 基准价拉不到，无法算收益

  const settle = (days: number, key: "return_7d" | "return_14d" | "return_30d") => {
    const target = addDays(rec.decision_date, days);
    const price = findCloseOnOrAfter(target);
    if (price !== undefined && entry > 0) {
      result[key] = Math.round((price - entry) / entry * 1000) / 10;  // 保留 1 位小数
    }
  };

  settle(7, "return_7d");
  settle(14, "return_14d");
  settle(30, "return_30d");
  return result;
}

/** 给 YYYY-MM-DD 加 days 天，返回 YYYY-MM-DD（纯字符串操作避免时区坑）。 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
