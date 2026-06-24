import { describe, it, expect } from "vitest";
import { computeOrderId } from "../../../src/watchlist/order-id";
import { makePendingExecution } from "../../../src/watchlist/execution-schema";
import type { LastRebalance } from "../../../src/watchlist/rebalance-types";

describe("last_rebalance.json 信封结构", () => {
  it("完整字段：order_id + actions + execution_sequence + execution", () => {
    const actions = [{ action: "SELL" as const, ticker: "SZ300319", weight: 0 }];
    const last: LastRebalance = {
      date: "2026-06-23",
      order_id: computeOrderId("2026-06-23", actions),
      actions,
      execution_sequence: [{ step: 1, action: "SELL", ticker: "SZ300319", name: "麦捷科技", weight_delta: -0.10, est_cash_after: 0.90 }],
      recent_sells: { SZ300319: "2026-06-23" },
      execution: makePendingExecution(),
    };
    expect(last.order_id).toMatch(/^2026-06-23-[a-f0-9]{6}$/);
    expect(last.execution!.status).toBe("pending");
    expect(last.execution_sequence).toHaveLength(1);
  });
});
