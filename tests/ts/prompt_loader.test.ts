import { describe, it, expect } from "vitest";
import { renderTemplate, loadPrompt, loadAndRender } from "../../src/prompt-loader";

describe("Prompt Template Loader", () => {
  describe("renderTemplate", () => {
    it("should replace {{placeholder}} with value", () => {
      const template = "Hello {{name}}, your score is {{score}}.";
      const vars = { name: "Alice", score: "95" };
      const result = renderTemplate(template, vars);
      expect(result).toBe("Hello Alice, your score is 95.");
    });

    it("should handle missing placeholders gracefully (leave them as-is)", () => {
      const template = "Hello {{name}}, your role is {{role}}.";
      const vars = { name: "Bob" };
      const result = renderTemplate(template, vars);
      expect(result).toBe("Hello Bob, your role is {{role}}.");
    });

    it("should handle multi-line templates", () => {
      const template = `# Analysis Report

Stock: {{ticker}}
Date: {{date}}

Summary:
{{summary}}

Recommendation: {{recommendation}}`;
      const vars = {
        ticker: "AAPL",
        date: "2026-06-05",
        summary: "Strong bullish signal",
        recommendation: "BUY"
      };
      const result = renderTemplate(template, vars);
      expect(result).toContain("Stock: AAPL");
      expect(result).toContain("Date: 2026-06-05");
      expect(result).toContain("Summary:\nStrong bullish signal");
      expect(result).toContain("Recommendation: BUY");
    });
  });

  describe("loadPrompt", () => {
    it("should load template file from disk", () => {
      const content = loadPrompt("analysts/market.md");
      expect(content).toContain("PLACEHOLDER — market analyst prompt");
    });

    it("should load portfolio manager template", () => {
      const content = loadPrompt("portfolio_manager.md");
      expect(content).toContain("PLACEHOLDER — portfolio manager prompt");
    });
  });

  describe("loadAndRender", () => {
    it("should load and render template in one call", () => {
      const template = "Analyze {{ticker}} for {{date}}";
      const vars = { ticker: "TSLA", date: "2026-06-05" };
      const result = renderTemplate(template, vars);
      expect(result).toBe("Analyze TSLA for 2026-06-05");
    });
  });
});
