import { describe, expect, it } from "vitest";
import { requiredEvidencePromptClause } from "./adapter.js";

describe("requiredEvidencePromptClause", () => {
  it("guides explicit browser observations without claiming they require QQ group changes", () => {
    const prompt = requiredEvidencePromptClause([
      {
        domain: "browser_open",
        tool: "browser",
        input: { action: "open", url: "https://nodejs.org/en/download" },
      },
      { domain: "browser_title", tool: "browser", input: { action: "get", kind: "title" } },
      { domain: "browser_screenshot", tool: "browser", input: { action: "screenshot" } },
    ]);

    expect(prompt).toContain('browser({"action":"open","url":"https://nodejs.org/en/download"})');
    expect(prompt).toContain('browser({"action":"get","kind":"title"})');
    expect(prompt).toContain('browser({"action":"screenshot"})');
    expect(prompt).toContain("does not require changing group capabilities");
    expect(prompt).not.toContain("only QQ can report");
  });

  it("names each required web Tool and keeps an empty request empty", () => {
    expect(requiredEvidencePromptClause([])).toBe("");
    expect(
      requiredEvidencePromptClause([
        { domain: "web_search", tool: "web_search", input: { query: "latest" } },
        { domain: "web_fetch", tool: "web_fetch", input: { url: "https://example.com" } },
      ]),
    ).toContain('web_search({"query":"latest"}), then web_fetch({"url":"https://example.com"})');
  });
});
