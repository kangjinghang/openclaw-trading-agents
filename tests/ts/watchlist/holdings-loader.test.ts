// tests/ts/watchlist/holdings-loader.test.ts
import { describe, it, expect } from "vitest";
import { loadHoldings, validateHoldings, computeLocked } from "../../../src/watchlist/holdings-loader";
import type { Holdings } from "../../../src/watchlist/rebalance-types";

const VALID: Holdings = {
  updated_at: "2026-06-21T20:00:00+08:00",
  cash_pct: 0.15,
  positions: [
    { ticker: "SH600519", name: "贵州茅台", weight: 0.50, entry_price: 1700, entry_date: "2026-05-20", shares: 100, sector: "白酒" },
    { ticker: "SZ300319", name: "麦捷科技", weight: 0.35, entry_price: 25, entry_date: "2026-06-15", shares: 200, sector: "电子" },
  ],
};

describe("validateHoldings", () => {
  it("通过：sum(positions.weight) + cash_pct ≈ 1.0", () => {
    expect(validateHoldings(VALID)).toEqual({ ok: true, error: null });
  });

  it("失败：sum ≠ 1.0", () => {
    const bad = { ...VALID, cash_pct: 0.50 };
    const r = validateHoldings(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/权重和.*1\.35/);
  });

  it("失败：缺 sector 字段", () => {
    const bad: Holdings = { ...VALID, positions: [{ ...VALID.positions[0], sector: "" }] };
    const r = validateHoldings(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sector/);
  });
});

describe("computeLocked", () => {
  it("entry_date 在 7 天内 → locked=true", () => {
    expect(computeLocked("2026-06-15", "2026-06-21", 7)).toBe(true);
  });

  it("entry_date 在 7 天前或更早 → locked=false", () => {
    expect(computeLocked("2026-06-14", "2026-06-21", 7)).toBe(false);
  });

  it("anti_churn_days=0 → 永不锁定", () => {
    expect(computeLocked("2026-06-21", "2026-06-21", 0)).toBe(false);
  });

  it("entry_date 格式错误 → locked=false（防御性）", () => {
    expect(computeLocked("invalid", "2026-06-21", 7)).toBe(false);
  });
});
