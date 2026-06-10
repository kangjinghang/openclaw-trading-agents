import { describe, it, expect } from "vitest";
import { PipelineHealth } from "../../src/pipeline-health";

describe("Pipeline Health Integration", () => {
  it("CP1: aborts when majority of scripts fail", () => {
    const h = new PipelineHealth("run-test");
    h.check("data_collection", "abort", "majority_scripts_failed", false, "5/7 scripts failed");
    expect(h.hasAbort).toBe(true);
    expect(h.getIssues("data_collection")).toHaveLength(1);
    expect(h.getIssues("data_collection")[0].severity).toBe("abort");
  });

  it("CP1: passes when scripts succeed", () => {
    const h = new PipelineHealth("run-test");
    h.check("data_collection", "abort", "majority_scripts_failed", true, "should not appear");
    expect(h.hasAbort).toBe(false);
    expect(h.issues).toHaveLength(0);
  });

  it("CP2: skip when template placeholders remain", () => {
    const h = new PipelineHealth("run-test");
    h.add({ stage: "template_render", severity: "skip", check: "placeholders_remaining",
      message: "news 有 2 个占位符未替换", context: { role: "news", placeholders: ["stock_news", "macro_news"] } });
    expect(h.hasAbort).toBe(false); // skip != abort
    expect(h.getIssues("template_render")).toHaveLength(1);
    expect(h.getIssues("template_render")[0].severity).toBe("skip");
  });

  it("CP3: warns on short analyst output", () => {
    const h = new PipelineHealth("run-test");
    h.check("analyst_output", "warn", "content_too_short", false, "news only 50 chars", { role: "news", contentLength: 50 });
    expect(h.hasAbort).toBe(false);
    expect(h.getIssues("analyst_output")).toHaveLength(1);
  });

  it("CP4-6: accumulating issues from multiple stages", () => {
    const h = new PipelineHealth("run-test");
    h.add({ stage: "quality_gate", severity: "warn", check: "layer1_grade", message: "news grade D" });
    h.add({ stage: "quality_review", severity: "warn", check: "fabrication_suspect", message: "fundamentals suspect" });
    h.add({ stage: "cross_stage", severity: "warn", check: "retries_exhausted", message: "retries exhausted" });
    expect(h.issues).toHaveLength(3);
    expect(h.hasAbort).toBe(false);
    expect(h.toJSON()).toHaveLength(3);
  });

  it("abort blocks even with other warn issues", () => {
    const h = new PipelineHealth("run-test");
    h.add({ stage: "analyst_output", severity: "warn", check: "verdict_missing", message: "m" });
    h.add({ stage: "data_collection", severity: "abort", check: "majority_failed", message: "m" });
    h.add({ stage: "cross_stage", severity: "warn", check: "test", message: "m" });
    expect(h.hasAbort).toBe(true);
    expect(h.issues).toHaveLength(3);
  });

  it("toJSON is safe to serialize for report", () => {
    const h = new PipelineHealth("run-test");
    h.add({ stage: "template_render", severity: "skip", check: "placeholders_remaining",
      message: "test", context: { role: "news" } });
    const json = JSON.stringify(h.toJSON());
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].stage).toBe("template_render");
  });
});
