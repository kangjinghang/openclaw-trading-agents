import { describe, it, expect } from "vitest";
import { mapIndustryToL1, SW_L1_INDUSTRIES } from "../../../src/watchlist/industry-map";

// ── 历史回测出现过的二级标签（必须全部正确映射）──────────────────────────
// 这些是 2026-06 回测里实际从东财 BOARD_NAME 拿到的标签，是回归基准。
describe("mapIndustryToL1: 历史回测标签", () => {
  it("电子下属二级全部映射到「电子」", () => {
    expect(mapIndustryToL1("半导体")).toBe("电子");
    expect(mapIndustryToL1("元件")).toBe("电子");
    expect(mapIndustryToL1("光学光电子")).toBe("电子");
    expect(mapIndustryToL1("消费电子")).toBe("电子");
    expect(mapIndustryToL1("其他电子Ⅱ")).toBe("电子");
    expect(mapIndustryToL1("电子化学品Ⅱ")).toBe("电子");
  });

  it("PCB（非标三级标签）特判映射到「电子」", () => {
    // PCB 不是申万二级，是电子→元件→印制电路板三级，东财 datacenter 特有
    expect(mapIndustryToL1("PCB")).toBe("电子");
  });

  it("军工电子Ⅱ 映射到「国防军工」而非「电子」", () => {
    // 最易错分的陷阱：名字带"电子"但归属军工
    expect(mapIndustryToL1("军工电子Ⅱ")).toBe("国防军工");
  });

  it("其他历史标签正确映射", () => {
    expect(mapIndustryToL1("航空装备Ⅱ")).toBe("国防军工");
    expect(mapIndustryToL1("计算机设备")).toBe("计算机");
    expect(mapIndustryToL1("纺织制造")).toBe("纺织服饰");
    expect(mapIndustryToL1("化学制品")).toBe("基础化工");
  });

  it("一级名直接命中（东财偶尔返回一级名）", () => {
    expect(mapIndustryToL1("电子")).toBe("电子");
    expect(mapIndustryToL1("国防军工")).toBe("国防军工");
    expect(mapIndustryToL1("计算机")).toBe("计算机");
  });
});

// ── 兜底逻辑 ──────────────────────────────────────────────────────────────
describe("mapIndustryToL1: 兜底", () => {
  it("空串/undefined/null 返回空串", () => {
    expect(mapIndustryToL1("")).toBe("");
    expect(mapIndustryToL1(undefined)).toBe("");
    expect(mapIndustryToL1(null)).toBe("");
  });

  it("「未分类」原样返回（不混入任何一级，让规则3单独累计）", () => {
    expect(mapIndustryToL1("未分类")).toBe("未分类");
  });

  it("未知标签原样返回（不强行归类，避免误合并）", () => {
    expect(mapIndustryToL1("某个新板块")).toBe("某个新板块");
    expect(mapIndustryToL1("东财自定义名")).toBe("东财自定义名");
  });

  it("东财 BOARD_NAME 省略Ⅱ后缀也能命中（回测真实发现）", () => {
    // 东财 datacenter 的 BOARD_NAME 实测会省略申万二级名的罗马数字Ⅱ
    // 如国瓷材料返回"电子化学品"而非"电子化学品Ⅱ" → 必须仍能映射到电子
    expect(mapIndustryToL1("电子化学品")).toBe("电子");
    expect(mapIndustryToL1("其他电子")).toBe("电子");
    expect(mapIndustryToL1("白酒")).toBe("食品饮料");
    expect(mapIndustryToL1("中药")).toBe("医药生物");
    expect(mapIndustryToL1("燃气")).toBe("公用事业");
  });

  it("幂等：一级名再映射仍是自己", () => {
    for (const l1 of SW_L1_INDUSTRIES) {
      expect(mapIndustryToL1(mapIndustryToL1(l1))).toBe(l1);
    }
  });
});

// ── 映射表完整性（防止硬编码遗漏）──────────────────────────────────────────
describe("mapIndustryToL1: 31 个一级全覆盖", () => {
  it("每个一级名都能被识别（SW_L1_INDUSTRIES 非空且互相不误合并）", () => {
    expect(SW_L1_INDUSTRIES.size).toBe(31);
    // 抽查几个容易混淆的一级不会互相串
    expect(mapIndustryToL1("电子")).not.toBe("国防军工");
    expect(mapIndustryToL1("基础化工")).not.toBe("石油石化");
    expect(mapIndustryToL1("煤炭")).not.toBe("石油石化");
  });

  it("电子下属 6 个二级 + PCB = 7 个标签都归电子（核心回归）", () => {
    const electronics = ["半导体", "元件", "光学光电子", "消费电子", "其他电子Ⅱ", "电子化学品Ⅱ", "PCB"];
    for (const tag of electronics) {
      expect(mapIndustryToL1(tag)).toBe("电子");
    }
  });

  it("国防军工下属 5 个二级都归国防军工（不含军工电子Ⅱ 误入电子）", () => {
    const military = ["航天装备Ⅱ", "航空装备Ⅱ", "地面兵装Ⅱ", "航海装备Ⅱ", "军工电子Ⅱ"];
    for (const tag of military) {
      expect(mapIndustryToL1(tag)).toBe("国防军工");
    }
  });
});
