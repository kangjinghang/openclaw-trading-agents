import { describe, it, expect } from "vitest";
import {
  filterCommon,
  filterShortExtra,
  formatLongEntry,
  formatShortEntry,
  parseRankResponse,
  fallbackRank,
  enrichRanked,
  mergeScan,
  rankCandidates,
  computeDistribution,
  classifyTodayCatalyst,
  computeBreakdown,
  type RankLlmCaller,
} from "../../../src/watchlist/ranker";
import type {
  CandidateEntry,
  CandidatesFile,
  RawRange,
} from "../../../src/watchlist/types";

// ── helpers ────────────────────────────────────────────────────────────────

const DEFAULT_RANGE: RawRange = {
  begin: 100,
  end: 200,
  type: "LONG",
  percent: 50,
  summary: "测试摘要",
  points: "个股驱动：x\n\n行业驱动：y\n\n市场驱动：z",
  url: "https://x",
  title: "t",
};

function makeCandidate(over: Partial<CandidateEntry> = {}): CandidateEntry {
  return {
    ticker: "SZ000001",
    name: "测试股",
    range: { ...DEFAULT_RANGE, ...(over.range ?? {}) },
    range_kind: "continued",
    days: 10,
    range_events: [],
    ...over,
  };
}

function makeCandidatesFile(up: CandidateEntry[], scanDate = "2026-06-17"): CandidatesFile {
  return { scan_date: scanDate, up };
}

// ── 共同过滤 ──────────────────────────────────────────────────────────────────

describe("filterCommon (ST/退/科创板 SH688)", () => {
  it("保留正常股", () => {
    expect(filterCommon(makeCandidate({ ticker: "SZ000001", name: "平安银行" }))).toBe(true);
    expect(filterCommon(makeCandidate({ ticker: "SH600519", name: "贵州茅台" }))).toBe(true);
  });

  it("排除 ST 股（前缀 ST / *ST）", () => {
    expect(filterCommon(makeCandidate({ ticker: "SH600537", name: "*ST金钰" }))).toBe(false);
    expect(filterCommon(makeCandidate({ ticker: "SH603959", name: "ST光线" }))).toBe(false);
  });

  it("排除退市整理股（前/后缀 退）", () => {
    expect(filterCommon(makeCandidate({ ticker: "SZ000020", name: "中弘退" }))).toBe(false);
    expect(filterCommon(makeCandidate({ ticker: "SZ000020", name: "退市XX" }))).toBe(false);
  });

  it("不误伤名字含 ST 字样的正常股（如 BEST...）", () => {
    // "BEST" 含子串 "ST"，但不在边界，正则不应匹配
    expect(filterCommon(makeCandidate({ ticker: "SH600001", name: "BEST科技" }))).toBe(true);
  });

  it("排除科创板 SH688（用户无交易权限）", () => {
    expect(filterCommon(makeCandidate({ ticker: "SH688146", name: "中船特气" }))).toBe(false);
    expect(filterCommon(makeCandidate({ ticker: "SH688598", name: "金博股份" }))).toBe(false);
  });
});

// ── SHORT 专有过滤 ─────────────────────────────────────────────────────────────

describe("filterShortExtra (continued/new + 今日)", () => {
  it("continued 一律保留（无论有无今日异动）", () => {
    expect(filterShortExtra(makeCandidate({ range_kind: "continued", range_events: [] }))).toBe(true);
  });

  it("new + 今日有异动（range_events 含 timestamp===range.end）→ 保留", () => {
    const c = makeCandidate({
      range_kind: "new",
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [{ timestamp: 200, description: "今日涨幅5%", reason: "r" }],
    });
    expect(filterShortExtra(c)).toBe(true);
  });

  it("new + 无今日异动 → 丢弃（衰竭信号）", () => {
    const c = makeCandidate({
      range_kind: "new",
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [{ timestamp: 150, description: "区间中段", reason: "r" }],
    });
    expect(filterShortExtra(c)).toBe(false);
  });

  it("new + 空事件链 → 丢弃", () => {
    expect(filterShortExtra(makeCandidate({ range_kind: "new", range_events: [] }))).toBe(false);
  });
});

// ── 格式 B 输入构造 ──────────────────────────────────────────────────────────

describe("formatLongEntry / formatShortEntry", () => {
  it("LONG 包含 5 段：区间/摘要/驱动要点/区间事件链（必须有事件链行）", () => {
    const c = makeCandidate({ range_events: [{ timestamp: 100, description: "起点", reason: "r" }] });
    const out = formatLongEntry(c, 0);
    expect(out).toContain("### 1. SZ000001 测试股");
    expect(out).toContain("- 区间: +50% (10天, 延续型)");
    expect(out).toContain("- 摘要: 测试摘要");
    expect(out).toContain("- 驱动要点:");
    expect(out).toContain("- 区间事件链:");
  });

  it("LONG 事件链空时显示 (无)", () => {
    const out = formatLongEntry(makeCandidate({ range_events: [] }), 0);
    expect(out).toContain("- 区间事件链: (无)");
  });

  it("SHORT 包含 4 段 + 今日（不含事件链）", () => {
    const c = makeCandidate({
      range_kind: "new",
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [{ timestamp: 200, description: "今日涨幅6.31%", reason: "催化" }],
    });
    const out = formatShortEntry(c, 0);
    expect(out).toContain("- 摘要:");
    expect(out).toContain("- 驱动要点:");
    expect(out).toContain("- 今日: 今日涨幅6.31% (催化)");
    expect(out).not.toContain("- 区间事件链:"); // SHORT 不含事件链段
  });

  it("SHORT 今日空时显示 (无)", () => {
    const c = makeCandidate({
      range_kind: "continued",
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [{ timestamp: 150, description: "区间中段", reason: "r" }],
    });
    expect(formatShortEntry(c, 0)).toContain("- 今日: (无)");
  });

  it("下跌 percent 显示带负号（无 + 前缀）", () => {
    const c = makeCandidate({ range: { ...DEFAULT_RANGE, percent: -10 } });
    expect(formatLongEntry(c, 0)).toContain("- 区间: -10% (10天, 延续型)");
  });
});

// ── LLM 输出解析 ────────────────────────────────────────────────────────────

describe("parseRankResponse", () => {
  const valid = new Set(["SZ000001", "SZ000002", "SZ000003"]);

  it("解析裸 JSON 对象", () => {
    const content = JSON.stringify({
      ranked: [{ ticker: "SZ000001", name: "x", score: 9, reason: "ok" }],
      excluded: [{ ticker: "SZ000002", name: "y", reason: "no" }],
    });
    const r = parseRankResponse(content, valid);
    expect(r).not.toBeNull();
    expect(r!.ranked).toHaveLength(1);
    expect(r!.excluded).toHaveLength(1);
  });

  it("解析 ```json 代码块包裹", () => {
    const content = "分析结果：\n```json\n" + JSON.stringify({
      ranked: [{ ticker: "SZ000001", name: "x", score: 9, reason: "ok" }],
      excluded: [],
    }) + "\n```";
    const r = parseRankResponse(content, valid);
    expect(r).not.toBeNull();
    expect(r!.ranked[0].ticker).toBe("SZ000001");
  });

  it("解析 LLM 散文前后有文字的情况", () => {
    const content = "好的，我来进行排名。\n{\n  \"ranked\": [{\"ticker\":\"SZ000001\",\"name\":\"x\",\"score\":8.5,\"reason\":\"强\"}],\n  \"excluded\": []\n}\n以上就是我的分析。";
    const r = parseRankResponse(content, valid);
    expect(r).not.toBeNull();
    expect(r!.ranked[0].score).toBe(8.5);
  });

  it("过滤幻觉 ticker（不在 validTickers 中）", () => {
    const content = JSON.stringify({
      ranked: [
        { ticker: "SZ000001", name: "x", score: 9, reason: "ok" },
        { ticker: "SZ999999", name: "fake", score: 10, reason: "幻觉" },
      ],
      excluded: [],
    });
    const r = parseRankResponse(content, valid);
    expect(r!.ranked).toHaveLength(1); // 幻觉的过滤掉
    expect(r!.ranked[0].ticker).toBe("SZ000001");
  });

  it("非 JSON 输出返回 null", () => {
    expect(parseRankResponse("完全是散文没有 json", valid)).toBeNull();
    expect(parseRankResponse("", valid)).toBeNull();
  });

  it("JSON 缺 ranked 或 excluded 字段返回 null", () => {
    expect(parseRankResponse(JSON.stringify({ ranked: [] }), valid)).toBeNull();
    expect(parseRankResponse(JSON.stringify({ excluded: [] }), valid)).toBeNull();
  });

  it("字段类型缺失时填默认值（name→空串，score→0，reason→空串）", () => {
    const content = JSON.stringify({
      ranked: [{ ticker: "SZ000001" }],  // 缺 name/score/reason
      excluded: [],
    });
    const r = parseRankResponse(content, valid);
    expect(r!.ranked[0]).toEqual({ ticker: "SZ000001", name: "", score: 0, reason: "" });
  });
});

// ── 规则降级 ────────────────────────────────────────────────────────────────

describe("fallbackRank", () => {
  function makePool(n: number, daysArr: number[], pctArr: number[]): CandidateEntry[] {
    return Array.from({ length: n }, (_, i) =>
      makeCandidate({
        ticker: `SZ${String(i + 1).padStart(6, "0")}`,
        days: daysArr[i],
        range: { ...DEFAULT_RANGE, percent: pctArr[i] },
      }),
    );
  }

  it("LONG 按 days 降序 → |percent| 降序", () => {
    const pool = makePool(3, [30, 50, 40], [100, 50, 80]);
    const r = fallbackRank(pool, 3, "LONG");
    expect(r.ranked.map((x) => x.ticker)).toEqual(["SZ000002", "SZ000003", "SZ000001"]);
  });

  it("SHORT 按 |percent| 降序 → days 降序", () => {
    const pool = makePool(3, [5, 9, 7], [20, 50, 50]);
    const r = fallbackRank(pool, 3, "SHORT");
    expect(r.ranked.map((x) => x.ticker)).toEqual(["SZ000002", "SZ000003", "SZ000001"]);
  });

  it("分数 6.0 起步 -0.2 递减，最低 4.0", () => {
    const pool = makePool(15, Array.from({ length: 15 }, (_, i) => 50 - i), Array.from({ length: 15 }, () => 50));
    const r = fallbackRank(pool, 15, "LONG");
    expect(r.ranked[0].score).toBe(6.0);
    expect(r.ranked[1].score).toBe(5.8);
    expect(r.ranked[10].score).toBe(4.0); // 6.0 - 10*0.2 = 4.0，到下限
    expect(r.ranked[14].score).toBe(4.0); // 不能低于 4.0
  });

  it("不足 topN 时全部入选，不补齐", () => {
    const pool = makePool(3, [10, 20, 30], [10, 20, 30]);
    const r = fallbackRank(pool, 10, "LONG");
    expect(r.ranked).toHaveLength(3);
    expect(r.excluded).toHaveLength(0);
  });

  it("reason 标注 [规则降级]", () => {
    const r = fallbackRank([makeCandidate()], 5, "LONG");
    expect(r.ranked[0].reason).toContain("[规则降级]");
  });
});

// ── 字段补齐 ────────────────────────────────────────────────────────────────

describe("enrichRanked", () => {
  it("LLM 返回字段 + 候选股反查 → 补 percent/days/range_kind", () => {
    const c = makeCandidate({
      ticker: "SZ000001",
      name: "测试股",
      range: { ...DEFAULT_RANGE, percent: 371.9 },
      days: 86,
      range_kind: "new",
    });
    const lookup = new Map([["SZ000001", c]]);
    const out = enrichRanked(
      [{ ticker: "SZ000001", name: "x", score: 9.0, reason: "ok" }],
      lookup,
    );
    expect(out[0]).toEqual({
      ticker: "SZ000001",
      // name 取候选池权威值（makeCandidate 设的"测试股"），非 LLM 的"x"
      name: "测试股",
      score: 9.0,
      percent: 371.9,
      days: 86,
      range_kind: "new",
      reason: "ok",
    });
  });

  it("ticker 查不到时填默认值（防御性兜底，不应触发）", () => {
    const out = enrichRanked(
      [{ ticker: "SZ999999", name: "x", score: 5, reason: "r" }],
      new Map(),
    );
    expect(out[0].percent).toBe(0);
    expect(out[0].days).toBe(0);
  });

  it("LLM 串号（ticker 真实但 name 错配）时用候选池权威 name 覆盖", () => {
    // 复现真实 bug：candidates 里 SH603259=药明康德（权威），但 LLM 把
    // 大元泵业（真实代码 SH603757）的理由串到了 SH603259。parseRankResponse
    // 只校验 ticker 真实性，放行了这类错配；enrichRanked 必须用候选池 name 纠正。
    const lookup = new Map([
      ["SH603259", makeCandidate({ ticker: "SH603259", name: "药明康德" })],
    ]);
    const out = enrichRanked(
      [{ ticker: "SH603259", name: "大元泵业", score: 9.5, reason: "谷歌液冷泵订单" }],
      lookup,
    );
    expect(out[0].name).toBe("药明康德");
    // reason 是 LLM 的分析，保留不覆盖（即便串号，理由本身可能仍可读）
    expect(out[0].reason).toBe("谷歌液冷泵订单");
  });
});

// ── 主流程 rankCandidates ────────────────────────────────────────────────────

describe("rankCandidates (主流程)", () => {
  function makeMockCaller(response: string): RankLlmCaller & { calls: number } {
    const fn = (async () => {
      fn.calls++;
      return response;
    }) as RankLlmCaller & { calls: number };
    fn.calls = 0;
    return fn;
  }

  it("LLM 成功：补齐字段，输出 ranked + excluded", async () => {
    const longCands = [
      makeCandidate({ ticker: "SZ000001", range: { ...DEFAULT_RANGE, type: "LONG" }, days: 50 }),
      makeCandidate({ ticker: "SZ000002", range: { ...DEFAULT_RANGE, type: "LONG" }, days: 30 }),
    ];
    const candidates = makeCandidatesFile(longCands);
    const llmResp = JSON.stringify({
      ranked: [{ ticker: "SZ000001", name: "x", score: 9.0, reason: "ok" }],
      excluded: [{ ticker: "SZ000002", name: "y", reason: "弱" }],
    });
    const result = await rankCandidates(candidates, {
      topLong: 7,
      topShort: 8,
      caller: makeMockCaller(llmResp),
    });
    expect(result.longResult.fallback).toBe(false);
    expect(result.longResult.ranked).toHaveLength(1);
    expect(result.longResult.ranked[0]).toMatchObject({
      ticker: "SZ000001",
      score: 9.0,
      days: 50,
    });
    expect(result.longResult.excluded).toHaveLength(1);
  });

  it("LLM 失败（异常）→ 规则降级，fallback=true", async () => {
    const longCands = [
      makeCandidate({ ticker: "SZ000001", range: { ...DEFAULT_RANGE, type: "LONG" }, days: 50 }),
    ];
    const candidates = makeCandidatesFile(longCands);
    const failingCaller: RankLlmCaller = async () => { throw new Error("network"); };
    const result = await rankCandidates(candidates, {
      topLong: 7, topShort: 8, caller: failingCaller,
    });
    expect(result.longResult.fallback).toBe(true);
    expect(result.longResult.ranked[0].reason).toContain("[规则降级]");
    expect(result.longResult.ranked[0].score).toBeLessThanOrEqual(6.0);
  });

  it("LLM 返回非 JSON → 规则降级", async () => {
    const candidates = makeCandidatesFile([
      makeCandidate({ ticker: "SZ000001", range: { ...DEFAULT_RANGE, type: "LONG" } }),
    ]);
    const result = await rankCandidates(candidates, {
      topLong: 7, topShort: 8, caller: makeMockCaller("完全不是 JSON 的散文"),
    });
    expect(result.longResult.fallback).toBe(true);
  });

  it("LLM 选出数量 < topN 时尊重实际数量，不强行补齐", async () => {
    const candidates = makeCandidatesFile([
      makeCandidate({ ticker: "SZ000001", range: { ...DEFAULT_RANGE, type: "LONG" } }),
      makeCandidate({ ticker: "SZ000002", range: { ...DEFAULT_RANGE, type: "LONG" } }),
      makeCandidate({ ticker: "SZ000003", range: { ...DEFAULT_RANGE, type: "LONG" } }),
    ]);
    const llmResp = JSON.stringify({
      ranked: [{ ticker: "SZ000001", name: "x", score: 9.0, reason: "只选 1 个" }],
      excluded: [],
    });
    const result = await rankCandidates(candidates, {
      topLong: 7, topShort: 8, caller: makeMockCaller(llmResp),
    });
    expect(result.longResult.ranked).toHaveLength(1);  // 不补齐
    expect(result.longResult.fallback).toBe(false);
  });

  it("SHORT 组记录 total_pre_filter / total_post_common_filter", async () => {
    const candidates = makeCandidatesFile([
      makeCandidate({ ticker: "SH688146", range: { ...DEFAULT_RANGE, type: "SHORT" } }), // 科创板，共同过滤丢
      makeCandidate({ ticker: "SZ300001", range_kind: "continued", range: { ...DEFAULT_RANGE, type: "SHORT" } }), // 共同过+SHORT过
      makeCandidate({ ticker: "SZ300002", range_kind: "new", range_events: [], range: { ...DEFAULT_RANGE, type: "SHORT" } }), // 共同过+SHORT专有丢
    ]);
    const llmResp = JSON.stringify({ ranked: [], excluded: [] });
    const result = await rankCandidates(candidates, {
      topLong: 7, topShort: 8, caller: makeMockCaller(llmResp),
    });
    expect(result.shortResult.total_pre_filter).toBe(3);
    expect(result.shortResult.total_post_common_filter).toBe(2); // 排掉 SH688146
    expect(result.shortResult.total).toBe(1);  // SZ300001 过 SHORT 专有
  });

  it("空组（候选为 0）不调 LLM、不降级、直接返回空", async () => {
    const candidates = makeCandidatesFile([]);  // 全空
    const caller = makeMockCaller("never called");
    const result = await rankCandidates(candidates, {
      topLong: 7, topShort: 8, caller,
    });
    expect(caller.calls).toBe(0);
    expect(result.longResult.ranked).toEqual([]);
    expect(result.shortResult.ranked).toEqual([]);
    expect(result.longResult.fallback).toBe(false);
  });

  it("distribution 快照写入结果（事后复盘用）", async () => {
    const candidates = makeCandidatesFile([
      makeCandidate({ ticker: "SZ000001", range: { ...DEFAULT_RANGE, type: "LONG", percent: 50 }, days: 30 }),
      makeCandidate({ ticker: "SZ000002", range: { ...DEFAULT_RANGE, type: "LONG", percent: 100 }, days: 50 }),
      makeCandidate({ ticker: "SZ000003", range: { ...DEFAULT_RANGE, type: "LONG", percent: 200 }, days: 70 }),
    ]);
    const result = await rankCandidates(candidates, {
      topLong: 7, topShort: 8, caller: makeMockCaller(JSON.stringify({ ranked: [], excluded: [] })),
    });
    expect(result.longResult.distribution).toBeDefined();
    expect(result.longResult.distribution?.percent.min).toBe(50);
    expect(result.longResult.distribution?.percent.max).toBe(200);
    expect(result.longResult.distribution?.percent.median).toBe(100);
    expect(result.longResult.distribution?.days.median).toBe(50);
    // SHORT 组 pool 为空 → 无 distribution
    expect(result.shortResult.distribution).toBeUndefined();
  });
});

// ── 分布统计 ──────────────────────────────────────────────────────────────────

describe("computeDistribution", () => {
  it("空数组返回 null", () => {
    expect(computeDistribution([])).toBeNull();
  });

  it("单个值：所有分位都等于该值", () => {
    expect(computeDistribution([50])).toEqual({ min: 50, p25: 50, median: 50, p75: 50, max: 50 });
  });

  it("多个值：算 min/p25/median/p75/max（线性插值）", () => {
    // 已知分布：[10, 20, 30, 40, 50, 60, 70, 80]
    // p25 = idx 1.75 → 20 + (30-20)*0.75 = 27.5
    // median = idx 3.5 → 40 + (50-40)*0.5 = 45
    // p75 = idx 5.25 → 60 + (70-60)*0.25 = 62.5
    const d = computeDistribution([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(d).toEqual({ min: 10, p25: 27.5, median: 45, p75: 62.5, max: 80 });
  });

  it("无序输入自动排序", () => {
    const d = computeDistribution([60, 10, 50, 20, 40, 70, 30, 80]);
    expect(d?.min).toBe(10);
    expect(d?.max).toBe(80);
    expect(d?.median).toBe(45);
  });
});

// ── 分类计数 ──────────────────────────────────────────────────────────────────

describe("classifyTodayCatalyst", () => {
  function makeReason(timestamp: number, description: string) {
    return { timestamp, description, reason: "r", url: "u" };
  }

  it("今日无事件 → none", () => {
    const c = makeCandidate({
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(150, "区间中段 +3%")],
    });
    expect(classifyTodayCatalyst(c)).toBe("none");
  });

  it("今日有涨停 → limit_up（优先级最高，即使数字小于 5%）", () => {
    const c = makeCandidate({
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(200, "放量涨停封板")],
    });
    expect(classifyTodayCatalyst(c)).toBe("limit_up");
  });

  it("今日涨幅 >5% → pct_over_5", () => {
    const c = makeCandidate({
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(200, "收盘价 X 元，涨幅 8.5%")],
    });
    expect(classifyTodayCatalyst(c)).toBe("pct_over_5");
  });

  it("今日涨幅 ≤5% → pct_under_5", () => {
    const c = makeCandidate({
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(200, "收盘价 X 元，涨幅 3.2%")],
    });
    expect(classifyTodayCatalyst(c)).toBe("pct_under_5");
  });

  it("今日多条事件，含涨停 → limit_up", () => {
    const c = makeCandidate({
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [
        makeReason(200, "涨幅 3%"),
        makeReason(200, "涨停"),
      ],
    });
    expect(classifyTodayCatalyst(c)).toBe("limit_up");
  });

  it("今日多条事件，取最大 pct", () => {
    const c = makeCandidate({
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [
        makeReason(200, "涨幅 3%"),
        makeReason(200, "涨幅 7.5%"),
      ],
    });
    expect(classifyTodayCatalyst(c)).toBe("pct_over_5");
  });

  it("今日事件但提取不出涨幅 → pct_under_5", () => {
    const c = makeCandidate({
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(200, "无数字描述")],
    });
    expect(classifyTodayCatalyst(c)).toBe("pct_under_5");
  });

  it("创业板 SZ300/SZ301 涨幅 ≥19.5% → limit_up（雪球 description 写涨幅而非涨停）", () => {
    const c = makeCandidate({
      ticker: "SZ300475",
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(200, "收盘价 X 元，涨幅 20.00%")],
    });
    expect(classifyTodayCatalyst(c)).toBe("limit_up");
  });

  it("科创板 SH688 涨幅 ≥19.5% → limit_up", () => {
    const c = makeCandidate({
      ticker: "SH688123",
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(200, "收盘价 X 元，涨幅 19.8%")],
    });
    expect(classifyTodayCatalyst(c)).toBe("limit_up");
  });

  it("主板涨幅 ≥9.5% → limit_up", () => {
    const c = makeCandidate({
      ticker: "SH600001",
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(200, "收盘价 X 元，涨幅 9.98%")],
    });
    expect(classifyTodayCatalyst(c)).toBe("limit_up");
  });

  it("主板涨幅 8% → pct_over_5（未达主板 9.5% 涨停阈值）", () => {
    const c = makeCandidate({
      ticker: "SH600001",
      range: { ...DEFAULT_RANGE, end: 200 },
      range_events: [makeReason(200, "收盘价 X 元，涨幅 8%")],
    });
    expect(classifyTodayCatalyst(c)).toBe("pct_over_5");
  });
});

describe("computeBreakdown", () => {
  it("空 pool 返回 null", () => {
    expect(computeBreakdown([])).toBeNull();
  });

  it("统计 range_kind + today_catalyst", () => {
    const pool = [
      makeCandidate({
        ticker: "A", range_kind: "continued",
        range: { ...DEFAULT_RANGE, end: 200 },
        range_events: [{ timestamp: 200, description: "涨停", reason: "r" }],
      }),
      makeCandidate({
        ticker: "B", range_kind: "continued",
        range: { ...DEFAULT_RANGE, end: 200 },
        range_events: [{ timestamp: 200, description: "涨幅 8%", reason: "r" }],
      }),
      makeCandidate({
        ticker: "C", range_kind: "new",
        range: { ...DEFAULT_RANGE, end: 200 },
        range_events: [{ timestamp: 150, description: "区间中段", reason: "r" }], // 今日无
      }),
    ];
    const b = computeBreakdown(pool);
    expect(b?.range_kind).toEqual({ continued: 2, new: 1 });
    expect(b?.today_catalyst).toEqual({
      limit_up: 1,
      pct_over_5: 1,
      pct_under_5: 0,
      none: 1,
    });
  });
});

// ── mergeScan ─────────────────────────────────────────────────────────────

describe("mergeScan", () => {
  it("top_picks 跨组按 score 降序合并", () => {
    const longResult = {
      scan_date: "2026-06-17", group: "LONG" as const, fallback: false,
      total: 35, ranked_count: 2, excluded_count: 0,
      ranked: [
        { ticker: "L1", name: "l1", score: 8.5, percent: 50, days: 50, range_kind: "new" as const, reason: "" },
        { ticker: "L2", name: "l2", score: 7.0, percent: 30, days: 40, range_kind: "continued" as const, reason: "" },
      ],
      excluded: [],
    };
    const shortResult = {
      scan_date: "2026-06-17", group: "SHORT" as const, fallback: false,
      total: 44, ranked_count: 1, excluded_count: 0,
      total_pre_filter: 138, total_post_common_filter: 110,
      ranked: [
        { ticker: "S1", name: "s1", score: 9.0, percent: 30, days: 9, range_kind: "new" as const, reason: "" },
      ],
      excluded: [],
    };
    const summary = mergeScan(longResult, shortResult, 178, "2026-06-17");
    expect(summary.top_picks.map((p) => p.ticker)).toEqual(["S1", "L1", "L2"]);
    expect(summary.top_picks[0].group).toBe("SHORT");
    expect(summary.groups.LONG.total).toBe(35);
    expect(summary.groups.SHORT.pre_filter).toBe(138);
    expect(summary.total_candidates).toBe(178);
  });
});
