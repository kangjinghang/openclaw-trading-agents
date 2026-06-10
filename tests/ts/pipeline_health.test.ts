import { describe, it, expect } from "vitest";
import { PipelineHealth } from "../../src/pipeline-health";

describe("PipelineHealth", () => {
  it("starts with no issues", () => {
    const h = new PipelineHealth("run-1");
    expect(h.issues).toEqual([]);
    expect(h.hasAbort).toBe(false);
  });

  it("check() registers issue when condition is false", () => {
    const h = new PipelineHealth("run-1");
    h.check("data_collection", "abort", "majority_failed", false, "5/7 scripts failed");
    expect(h.issues).toHaveLength(1);
    expect(h.issues[0].severity).toBe("abort");
    expect(h.hasAbort).toBe(true);
  });

  it("check() does nothing when condition is true", () => {
    const h = new PipelineHealth("run-1");
    h.check("data_collection", "abort", "majority_failed", true, "should not appear");
    expect(h.issues).toHaveLength(0);
  });

  it("add() registers an issue directly", () => {
    const h = new PipelineHealth("run-1");
    h.add({ stage: "template_render", severity: "skip", check: "placeholders_remaining",
      message: "news has 2 un-replaced placeholders", context: { role: "news" } });
    expect(h.issues).toHaveLength(1);
    expect(h.issues[0].context?.role).toBe("news");
  });

  it("getIssues(stage) filters by stage", () => {
    const h = new PipelineHealth("run-1");
    h.add({ stage: "data_collection", severity: "warn", check: "a", message: "m1" });
    h.add({ stage: "template_render", severity: "skip", check: "b", message: "m2" });
    h.add({ stage: "data_collection", severity: "warn", check: "c", message: "m3" });
    expect(h.getIssues("data_collection")).toHaveLength(2);
    expect(h.getIssues("template_render")).toHaveLength(1);
  });

  it("toJSON() returns the issues array", () => {
    const h = new PipelineHealth("run-1");
    h.add({ stage: "cross_stage", severity: "warn", check: "test", message: "msg" });
    expect(h.toJSON()).toEqual(h.issues);
  });

  it("multiple severities: only abort sets hasAbort", () => {
    const h = new PipelineHealth("run-1");
    h.add({ stage: "template_render", severity: "skip", check: "a", message: "m" });
    expect(h.hasAbort).toBe(false);
    h.add({ stage: "analyst_output", severity: "warn", check: "b", message: "m" });
    expect(h.hasAbort).toBe(false);
    h.add({ stage: "data_collection", severity: "abort", check: "c", message: "m" });
    expect(h.hasAbort).toBe(true);
  });

  it("check() with context passes context through", () => {
    const h = new PipelineHealth("run-1");
    h.check("template_render", "skip", "placeholders", false, "unreplaced", { role: "sentiment" });
    expect(h.issues[0].context).toEqual({ role: "sentiment" });
  });
});
