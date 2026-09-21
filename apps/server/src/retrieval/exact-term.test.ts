import { describe, expect, it } from "vitest";
import { carriesEveryExactTerm, exactTerms } from "./exact-term.js";

describe("the identifiers a query carries", () => {
  it("names the identifier a bare query is", () => {
    expect(exactTerms("P4B-A-1349")).toEqual(["p4b-a-1349"]);
  });

  it("names every identifier in a mixed query, in query order", () => {
    expect(exactTerms("查一下 P4B-A-1349 和 order_123 的记录")).toEqual([
      "p4b-a-1349",
      "order_123",
    ]);
  });

  it("names an identifier a sentence embeds", () => {
    expect(exactTerms("帮我找 P4B-A-1349 是谁发的")).toEqual(["p4b-a-1349"]);
  });

  it("reports a repeated identifier once", () => {
    expect(exactTerms("P4B-A-1349 ... p4b-a-1349")).toEqual(["p4b-a-1349"]);
  });

  it("does not carry a sentence's punctuation into the term", () => {
    expect(exactTerms("见 P4B-A-1349.")).toEqual(["p4b-a-1349"]);
    expect(exactTerms("见 P4B-A-1349，谢谢")).toEqual(["p4b-a-1349"]);
  });

  it("treats a long bare number as an identifier, because it addresses a record", () => {
    expect(exactTerms("1234567890")).toEqual(["1234567890"]);
  });

  it("leaves prose queries alone", () => {
    // A rule that fired on ordinary text would turn every search into a containment search
    // and answer "not found" for messages that really are about the question.
    for (const query of [
      "这个群有哪些成员？",
      "群公告是什么",
      "deploy rollback",
      "2024年总结",
      "这个群当前最新的消息",
      "1349 号记录",
      "v2",
      "iOS18",
      "a1",
    ])
      expect(exactTerms(query), query).toEqual([]);
  });
});

describe("whether a candidate carries the identifiers", () => {
  it("requires every named term to appear", () => {
    expect(carriesEveryExactTerm("详见 P4B-A-1349 的记录", ["p4b-a-1349"])).toBe(true);
    expect(carriesEveryExactTerm("P4B-A-1349 和 order_123 都在", ["p4b-a-1349", "order_123"])).toBe(
      true,
    );
    expect(carriesEveryExactTerm("只有 P4B-A-1349", ["p4b-a-1349", "order_123"])).toBe(false);
  });

  it("does not accept a message that merely shares a fragment", () => {
    // The incident's mechanism: `P4B-A-1349` tokenizes to `p4b`, `a`, `1349`, so a message
    // mentioning only `1349` scored as a hit and reached the model as a match.
    expect(carriesEveryExactTerm("编号 1349 已经修好了", ["p4b-a-1349"])).toBe(false);
    expect(carriesEveryExactTerm("P4B 这个流还没开始", ["p4b-a-1349"])).toBe(false);
    expect(carriesEveryExactTerm("A-1349 是另一回事", ["p4b-a-1349"])).toBe(false);
  });

  it("does not accept a longer identifier that merely contains it", () => {
    // `P4B-A-13490` is a different identifier, and answering with its message would credit a
    // sender, a time and a text to the identifier that was asked about.
    expect(carriesEveryExactTerm("P4B-A-13490 的发送者", ["p4b-a-1349"])).toBe(false);
    expect(carriesEveryExactTerm("xP4B-A-1349 的发送者", ["p4b-a-1349"])).toBe(false);
  });

  it("matches an identifier whatever case the message used", () => {
    expect(carriesEveryExactTerm("p4b-a-1349 已修复", ["p4b-a-1349"])).toBe(true);
  });

  it("carries nothing when the query named no identifier", () => {
    expect(carriesEveryExactTerm("deploy rollback", [])).toBe(true);
  });
});
