// tests/ts/watchlist/fitness-history-store.test.ts
// fitness 历史存储测试（环形 buffer / 去重 / 懒结算 settle / 容错）。
// 范式对齐 source-health-store.test.ts：mkdtemp + beforeEach/afterEach。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FitnessHistoryStore, BUFFER_SIZE, type FitnessRecord } from "../../../src/watchlist/fitness-history-store";

function makeRecord(overrides: Partial<FitnessRecord> = {}): FitnessRecord {
  return {
    decision_date: "2026-06-01",
    ticker: "SZ300319",
    name: "麦捷科技",
    action: "BUY",
    fitness: 8,
    overall_risk: "medium",
    target_weight: 0.03,
    entry_price: 0,
    run_id: "rebalance-2026-06-01",
    status: "open",
    ...overrides,
  };
}

describe("FitnessHistoryStore", () => {
  let tmpDir: string;
  let store: FitnessHistoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-history-"));
    store = new FitnessHistoryStore(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("read", () => {
    it("缺文件 → 空 state，不抛", () => {
      const f = store.read();
      expect(f.records).toEqual([]);
      expect(f.version).toBe(1);
    });

    it("坏 JSON → 空 state，不抛", () => {
      fs.writeFileSync(path.join(tmpDir, "fitness-history.json"), "{ not valid", "utf-8");
      const f = store.read();
      expect(f.records).toEqual([]);
    });

    it("version 不符 → 空 state", () => {
      fs.writeFileSync(path.join(tmpDir, "fitness-history.json"),
        JSON.stringify({ version: 99, records: [{ x: 1 }] }), "utf-8");
      expect(store.read().records).toEqual([]);
    });
  });

  describe("appendDecisions", () => {
    it("追加记录 → read 能读到 + status=open", () => {
      store.appendDecisions([makeRecord({ ticker: "A" }), makeRecord({ ticker: "B" })]);
      const recs = store.read().records;
      expect(recs).toHaveLength(2);
      expect(recs[0].status).toBe("open");
      expect(recs.map(r => r.ticker)).toEqual(["A", "B"]);
    });

    it("空数组 → 跳过，不写文件", () => {
      store.appendDecisions([]);
      expect(fs.existsSync(path.join(tmpDir, "fitness-history.json"))).toBe(false);
    });

    it("update-in-place：同 (date, ticker) 已存在时覆盖决策字段", () => {
      store.appendDecisions([makeRecord({ ticker: "A", fitness: 8, action: "BUY" })]);
      store.appendDecisions([makeRecord({ ticker: "A", fitness: 6, action: "HOLD" }), makeRecord({ ticker: "B" })]);
      const recs = store.read().records;
      expect(recs).toHaveLength(2);
      // A 的 fitness/action 被更新
      const a = recs.find(r => r.ticker === "A")!;
      expect(a.fitness).toBe(6);
      expect(a.action).toBe("HOLD");
    });

    it("update-in-place：保留 status 和 return 字段（不被覆盖）", () => {
      store.appendDecisions([makeRecord({ ticker: "A", fitness: 8 })]);
      store.settleRecord("2026-06-01", "A", { return_7d: 5.0 });
      // settled 的记录不被覆盖（只更新 open 的）
      store.appendDecisions([makeRecord({ ticker: "A", fitness: 3, action: "SELL" })]);
      const rec = store.read().records.find(r => r.ticker === "A")!;
      expect(rec.status).toBe("settled");
      expect(rec.return_7d).toBe(5.0);
      expect(rec.fitness).toBe(8);  // 不变，settled 不覆盖
    });

    it("环形 buffer：超 BUFFER_SIZE 淘汰最老", () => {
      // 填 BUFFER_SIZE + 50 条
      const batch: FitnessRecord[] = [];
      for (let i = 0; i < BUFFER_SIZE + 50; i++) {
        batch.push(makeRecord({ ticker: `T${i}`, decision_date: "2026-06-01" }));
      }
      store.appendDecisions(batch);
      const recs = store.read().records;
      expect(recs).toHaveLength(BUFFER_SIZE);
      // 最老的 T0..T49 被淘汰，T50 仍在
      expect(recs[0].ticker).toBe("T50");
    });
  });

  describe("settleRecord", () => {
    it("写 return_* + 标 settled", () => {
      store.appendDecisions([makeRecord({ ticker: "A" })]);
      store.settleRecord("2026-06-01", "A", { return_7d: 1.5, return_14d: 2.3, return_30d: -0.8 });
      const rec = store.read().records[0];
      expect(rec.status).toBe("settled");
      expect(rec.settled_at).toBeDefined();
      expect(rec.return_7d).toBe(1.5);
      expect(rec.return_30d).toBe(-0.8);
    });

    it("部分结算：只给部分 return → 其余留 undefined", () => {
      store.appendDecisions([makeRecord({ ticker: "A" })]);
      store.settleRecord("2026-06-01", "A", { return_7d: 1.5 });
      const rec = store.read().records[0];
      expect(rec.status).toBe("settled");
      expect(rec.return_7d).toBe(1.5);
      expect(rec.return_14d).toBeUndefined();
    });

    it("幂等：已 settled 的不再改", () => {
      store.appendDecisions([makeRecord({ ticker: "A" })]);
      store.settleRecord("2026-06-01", "A", { return_7d: 1.5 });
      store.settleRecord("2026-06-01", "A", { return_7d: 99 });  // 应被忽略
      expect(store.read().records[0].return_7d).toBe(1.5);  // 不变
    });

    it("不存在的记录 → 静默跳过", () => {
      store.appendDecisions([makeRecord({ ticker: "A" })]);
      store.settleRecord("2026-06-01", "NOTEXIST", { return_7d: 1 });
      expect(store.read().records).toHaveLength(1);
      expect(store.read().records[0].status).toBe("open");  // A 仍 open
    });
  });

  describe("getOpenRecords", () => {
    it("只返回 status=open 的", () => {
      store.appendDecisions([makeRecord({ ticker: "A" }), makeRecord({ ticker: "B" })]);
      store.settleRecord("2026-06-01", "A", { return_7d: 1 });
      const open = store.getOpenRecords();
      expect(open).toHaveLength(1);
      expect(open[0].ticker).toBe("B");
    });
  });
});
