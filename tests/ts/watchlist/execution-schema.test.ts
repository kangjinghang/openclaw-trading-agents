import { describe, it, expect } from "vitest";
import { isTerminal, isPending, makePendingExecution } from "../../../src/watchlist/execution-schema";
import type { ExecStatus } from "../../../src/watchlist/rebalance-types";

describe("isTerminal", () => {
  it("filled/partial/failed 是终态", () => {
    for (const s of ["filled", "partial", "failed"] as ExecStatus[]) {
      expect(isTerminal(s)).toBe(true);
    }
  });

  it("pending/executing 非终态", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("executing")).toBe(false);
  });
});

describe("isPending", () => {
  it("只有 pending 为 true", () => {
    expect(isPending("pending")).toBe(true);
    expect(isPending("executing")).toBe(false);
    expect(isPending("filled")).toBe(false);
  });
});

describe("makePendingExecution", () => {
  it("产出标准 pending 占位", () => {
    const e = makePendingExecution();
    expect(e).toEqual({
      status: "pending",
      executed_at: null,
      account_total_asset: null,
      fills: [],
      errors: [],
    });
  });

  it("每次调用返回新对象（无共享引用）", () => {
    const a = makePendingExecution();
    const b = makePendingExecution();
    a.fills.push({ ticker: "X", action: "BUY", order_sys_id: "", filled_price: 0, filled_volume: 0, intended_volume: 0, status: "filled" });
    expect(b.fills).toHaveLength(0);
  });
});
