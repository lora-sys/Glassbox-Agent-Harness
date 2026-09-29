import { describe, expect, it } from "vitest";
import { sourceStatementIsSubstantive } from "./source.js";

describe("sourceStatementIsSubstantive", () => {
  it("keeps a message that states something", () => {
    expect(sourceStatementIsSubstantive("Source fact.")).toBe(true);
    expect(sourceStatementIsSubstantive("  以后对外自称为 lorabot。  ")).toBe(true);
    expect(sourceStatementIsSubstantive("I prefer named exports")).toBe(true);
  });

  it("drops the messages that filled the review queue", () => {
    // Each of these was a real pending candidate on the night of 2026-09-28.
    expect(sourceStatementIsSubstantive("可以")).toBe(false);
    expect(sourceStatementIsSubstantive("风控有点严")).toBe(false);
    expect(sourceStatementIsSubstantive("微信群南")).toBe(false);
    expect(sourceStatementIsSubstantive("+1")).toBe(false);
    expect(sourceStatementIsSubstantive("哈哈哈哈哈哈哈哈哈哈哈哈")).toBe(false);
    expect(sourceStatementIsSubstantive("   ")).toBe(false);
  });

  it("drops a question, which asserts nothing", () => {
    expect(sourceStatementIsSubstantive("这个什么时候上线？")).toBe(false);
    expect(sourceStatementIsSubstantive("who are you?")).toBe(false);
    // A question mark in the middle of a statement does not make it a question.
    expect(sourceStatementIsSubstantive("他问了这个吗？我记着上了。")).toBe(true);
  });

  it("keeps an interrogative that carries no question mark, because telling them apart is not this filter's job", () => {
    // `@3394947361 who are you` was a real pending candidate. Deciding that it is a question takes
    // language understanding, so the bar leaves it queued and the required query is what keeps the
    // Owner from reading messages nobody asked about.
    expect(sourceStatementIsSubstantive("@3394947361 who are you")).toBe(true);
  });
});
