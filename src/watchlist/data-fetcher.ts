import * as path from "path";
import type { StockData } from "./shallow-analyzer";
import { execSkillScript } from "../exec-python";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** 从 kline.py 输出解析 K 线摘要。容忍字段缺失。 */
export function parseKline(raw: any): { pct_5d: number; pct_20d: number; support: number; resistance: number } {
  const closes: number[] = Array.isArray(raw?.closes) ? raw.closes : [];
  if (closes.length < 2) return { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 };
  const last = closes[closes.length - 1];
  const ago5 = closes.length > 5 ? closes[closes.length - 6] : closes[0];
  const ago20 = closes.length > 20 ? closes[closes.length - 21] : closes[0];
  const recent = closes.slice(-5);
  return {
    pct_5d: ago5 > 0 ? (last - ago5) / ago5 * 100 : 0,
    pct_20d: ago20 > 0 ? (last - ago20) / ago20 * 100 : 0,
    support: Math.min(...recent),
    resistance: Math.max(...recent),
  };
}

export function parseNews(raw: any): string[] {
  if (!Array.isArray(raw?.news)) return [];
  return raw.news.slice(0, 5).map((n: any) => typeof n?.title === "string" ? n.title : "").filter(Boolean);
}

export function parseHotMoney(raw: any): { net_5d: number } {
  return { net_5d: typeof raw?.net_5d === "number" ? raw.net_5d : 0 };
}

export function parseFundamentals(raw: any): { pe: number; pb: number; rev_q1: number; np_q1: number } {
  return {
    pe: typeof raw?.pe_ttm === "number" ? raw.pe_ttm : (typeof raw?.pe === "number" ? raw.pe : 0),
    pb: typeof raw?.pb === "number" ? raw.pb : 0,
    rev_q1: typeof raw?.revenue_q1 === "number" ? raw.revenue_q1 : (typeof raw?.rev_q1 === "number" ? raw.rev_q1 : 0),
    np_q1: typeof raw?.net_profit_q1 === "number" ? raw.net_profit_q1 : (typeof raw?.np_q1 === "number" ? raw.np_q1 : 0),
  };
}

/** 单股并行跑 4 个 script。失败的 script 返回 null 字段（容忍）。 */
export async function fetchStockData(
  ticker: string,
  name: string,
  sector: string,
  rankerThesis?: string,
): Promise<StockData | null> {
  const tasks = [
    safeCall(() => execSkillScript("trading-kline", "kline", PROJECT_ROOT, [ticker])),
    safeCall(() => execSkillScript("trading-news", "news", PROJECT_ROOT, [ticker])),
    safeCall(() => execSkillScript("trading-hot-money", "hot_money", PROJECT_ROOT, [ticker])),
    safeCall(() => execSkillScript("trading-fundamentals", "fundamentals", PROJECT_ROOT, [ticker])),
  ];
  const [klineR, newsR, hotR, fundR] = await Promise.all(tasks);

  const kline = klineR ? parseKline(klineR) : { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 };
  const news = newsR ? parseNews(newsR) : [];
  const hot = hotR ? parseHotMoney(hotR) : { net_5d: 0 };
  const fund = fundR ? parseFundamentals(fundR) : { pe: 0, pb: 0, rev_q1: 0, np_q1: 0 };

  return {
    ticker, name, sector,
    kline, news,
    hot_money: hot,
    fundamentals: fund,
    ranker_thesis: rankerThesis,
  };
}

/** 安全调用 execSkillScript，失败返回 null。返回 data 字段（已 JSON 解析）。 */
async function safeCall(fn: () => Promise<any>): Promise<any | null> {
  try {
    const result = await fn();
    if (!result || !result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}

/** 跨股并行 fetch（concurrency=5）。失败的股跳过。 */
export async function fetchAllStockData(
  metas: Array<{ ticker: string; name: string; sector: string; ranker_thesis?: string }>,
  concurrency: number = 5,
): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  const queue = [...metas];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const meta = queue.shift()!;
        try {
          const data = await fetchStockData(meta.ticker, meta.name, meta.sector, meta.ranker_thesis);
          if (data) result.set(meta.ticker, data);
        } catch {
          // 跳过失败的股
        }
      }
    })());
  }
  await Promise.all(workers);
  return result;
}
