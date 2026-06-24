import { describe, it, expect } from "vitest";
import { computeOrderId, canonicalizeActions } from "../../../src/watchlist/order-id";
import type { LastRebalanceAction } from "../../../src/watchlist/rebalance-types";

const acts: LastRebalanceAction[] = [
  { action: "SELL", ticker: "SZ300319", weight: 0 },
  { action: "REDUCE", ticker: "SH600183", weight: 0.05 },
];

describe("canonicalizeActions", () => {
  it("按 ticker 排序 + weight 四舍五入到 4 位", () => {
    const unsorted: LastRebalanceAction[] = [
      { action: "REDUCE", ticker: "SH600183", weight: 0.0500001 },
      { action: "SELL", ticker: "SZ300319", weight: 0 },
    ];
    // 乱序 + 浮点尾差 的规范化结果，应等于手动排好序的规范结果
    expect(canonicalizeActions(unsorted)).toBe(
      canonicalizeActions([acts[1], acts[0]]),
    );
  });

  it("浮点尾差不影响规范化（0.05 vs 0.0500001 同字符串）", () => {
    const a: LastRebalanceAction[] = [{ action: "BUY", ticker: "X", weight: 0.1 }];
    const b: LastRebalanceAction[] = [{ action: "BUY", ticker: "X", weight: 0.10000003 }];
    expect(canonicalizeActions(a)).toBe(canonicalizeActions(b));
  });
});

describe("computeOrderId", () => {
  it("格式 = date-<6位hex>", () => {
    const id = computeOrderId("2026-06-23", acts);
    expect(id).toMatch(/^2026-06-23-[a-f0-9]{6}$/);
  });

  it("相同 actions（任意顺序）→ 相同 id", () => {
    expect(computeOrderId("2026-06-23", [acts[1], acts[0]]))
      .toBe(computeOrderId("2026-06-23", acts));
  });

  it("改任一 weight（超 4 位精度）→ id 变", () => {
    const changed = [{ ...acts[0], weight: 0.01 }];
    expect(computeOrderId("2026-06-23", [...changed, acts[1]]))
      .not.toBe(computeOrderId("2026-06-23", acts));
  });

  it("不同 date → id 不同（即使 actions 相同）", () => {
    expect(computeOrderId("2026-06-24", acts))
      .not.toBe(computeOrderId("2026-06-23", acts));
  });

  it("确定性：同输入两次调用结果相同", () => {
    expect(computeOrderId("2026-06-23", acts))
      .toBe(computeOrderId("2026-06-23", acts));
  });
});
