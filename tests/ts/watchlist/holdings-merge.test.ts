import { describe, it, expect } from "vitest";
import { mergeHoldings } from "../../../src/watchlist/holdings-merge";
import type { Holdings } from "../../../src/watchlist/rebalance-types";
import type { QmtPosition, QmtAsset } from "../../../src/watchlist/holdings-merge";

const remote: Holdings = {
  updated_at: "2026-06-21T20:00:00+08:00",
  cash_pct: 0.80,
  positions: [
    { ticker: "SZ300319", name: "麦捷科技", weight: 0.10, entry_price: 25, entry_date: "2026-06-15", shares: 200, sector: "电子" },
    { ticker: "SH600183", name: "生益科技", weight: 0.10, entry_price: 30, entry_date: "2026-06-10", shares: 100, sector: "PCB" },
  ],
};

const asset: QmtAsset = { total: 100000, cash: 95000 };  // 5% 仓位

describe("mergeHoldings — 市场字段以 QMT 为准", () => {
  it("QMT 持仓覆盖 shares/entry_price/entry_date", () => {
    const positions: QmtPosition[] = [
      { ticker: "SZ300319", volume: 150, open_price: 26.5, open_date: "2026-06-15", market_value: 3975, can_use_volume: 150 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    const p = merged.positions.find(x => x.ticker === "SZ300319")!;
    expect(p.shares).toBe(150);
    expect(p.entry_price).toBe(26.5);
    expect(p.entry_date).toBe("2026-06-15");
  });

  it("weight 重算 = market_value / total_asset", () => {
    const positions: QmtPosition[] = [
      { ticker: "SZ300319", volume: 150, open_price: 26.5, open_date: "2026-06-15", market_value: 3975, can_use_volume: 150 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    expect(merged.positions.find(x => x.ticker === "SZ300319")!.weight)
      .toBeCloseTo(3975 / 100000, 4);
  });

  it("cash_pct 重算 = cash / total", () => {
    const merged = mergeHoldings(remote, [], asset);
    expect(merged.cash_pct).toBeCloseTo(95000 / 100000, 4);
  });
});

describe("mergeHoldings — 本地字段保留", () => {
  it("sector 保留（QMT 无此字段）", () => {
    const positions: QmtPosition[] = [
      { ticker: "SZ300319", volume: 200, open_price: 25, open_date: "2026-06-15", market_value: 5000, can_use_volume: 200 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    expect(merged.positions.find(x => x.ticker === "SZ300319")!.sector).toBe("电子");
  });

  it("name 保留（QMT 不提供）", () => {
    const positions: QmtPosition[] = [
      { ticker: "SH600183", volume: 100, open_price: 30, open_date: "2026-06-10", market_value: 3000, can_use_volume: 100 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    expect(merged.positions.find(x => x.ticker === "SH600183")!.name).toBe("生益科技");
  });
});

describe("mergeHoldings — 增删", () => {
  it("QMT 有但 remote 无 → 新增（sector 标“未分类”）", () => {
    const positions: QmtPosition[] = [
      { ticker: "SH600519", volume: 10, open_price: 1700, open_date: "2026-06-20", market_value: 17000, can_use_volume: 10 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    const p = merged.positions.find(x => x.ticker === "SH600519");
    expect(p).toBeDefined();
    expect(p!.sector).toBe("未分类");
    expect(p!.shares).toBe(10);
  });

  it("remote 有但 QMT volume=0 → 清仓删除", () => {
    const positions: QmtPosition[] = [
      { ticker: "SZ300319", volume: 0, open_price: 25, open_date: "2026-06-15", market_value: 0, can_use_volume: 0 },
    ];
    const merged = mergeHoldings(remote, positions, asset);
    expect(merged.positions.find(x => x.ticker === "SZ300319")).toBeUndefined();
  });
});

describe("mergeHoldings — 更新时间", () => {
  it("updated_at 更新为现在", () => {
    const merged = mergeHoldings(remote, [], asset);
    expect(merged.updated_at).not.toBe("2026-06-21T20:00:00+08:00");
    expect(new Date(merged.updated_at).getTime()).toBeLessThan(Date.now() + 1000);
  });
});
