import { describe, expect, it } from "vitest";
import { carriesEveryExactTerm, exactTerms, isBareExactTerm } from "./exact-term.js";

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

  it("names the identifier whatever width the input method emitted it in", () => {
    // Full-width digits and letters are the same value typed on a Chinese input method, and a
    // non-ASCII character inside the run splits it there. `P4B-A-１３４９` named the truncated
    // prefix `p4b-a`, which both answered with a near-miss message and dropped the message that
    // really carries the identifier; `Ｐ4B-A-1349` named `4b-a-1349` and matched nothing.
    expect(exactTerms("P4B-A-１３４９")).toEqual(["p4b-a-1349"]);
    expect(exactTerms("Ｐ4B-A-1349")).toEqual(["p4b-a-1349"]);
    expect(exactTerms("订单 ｏｒｄｅｒ＿１２３ 已处理")).toEqual(["order_123"]);
  });

  it("reads the value the same way on both sides, whatever width each side used", () => {
    // The width is a property of how the text was typed, not of the value, so a query typed
    // full-width and a message typed half-width name the same identifier and must match.
    expect(carriesEveryExactTerm("已合并 P4B-A-1349 到 main", exactTerms("P4B-A-１３４９"))).toBe(
      true,
    );
    expect(carriesEveryExactTerm("已合并 Ｐ4B-A-1349 到 main", exactTerms("P4B-A-1349"))).toBe(
      true,
    );
    expect(carriesEveryExactTerm("已合并 P4B-A-1349 到 main", exactTerms("Ｐ4B-A-1349"))).toBe(
      true,
    );
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

  it("leaves a date and a range alone, because they describe a day rather than a value", () => {
    // A digit-only segmented run is descriptive: `2026-09-18`, `10-20` and `9月18日` all name
    // the same day, so requiring one spelling verbatim answers "not found" for messages that
    // really are about the question. The query asks about a day, not about a string.
    for (const query of [
      "2026-09-18 那天谁说了什么",
      "10-20 号的记录",
      "2026/09/18 的记录",
      "2026-09-18",
    ])
      expect(exactTerms(query), query).toEqual([]);
    // A value with a letter in it is arbitrary by construction and stays a containment term,
    // including one that is mostly digits: `v1.2.3` is a release, not a description of a day.
    expect(exactTerms("v1.2.3 的更新")).toEqual(["v1.2.3"]);
    expect(exactTerms("P4B-A-1349 合并了吗")).toEqual(["p4b-a-1349"]);
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

  it("matches an identifier the message ends with the sentence's own punctuation", () => {
    // The query side already reads a trailing separator as the sentence's rather than the
    // value's. The candidate side has to read it the same way: a message that ends the
    // identifier with a full stop carries the identifier, and dropping it answers "not found"
    // for a message that is really there — the same class of wrong answer the containment rule
    // exists to prevent, from the other direction.
    expect(carriesEveryExactTerm("编号：P4B-A-1349.", ["p4b-a-1349"])).toBe(true);
    expect(carriesEveryExactTerm("订单 order_123. 已处理", ["order_123"])).toBe(true);
    expect(carriesEveryExactTerm("P4B-A-1349_", ["p4b-a-1349"])).toBe(true);
  });

  it("still rejects a longer identifier that continues past the separator", () => {
    // A trailing separator is the sentence's only when the value ends there. `P4B-A-1349.2` is
    // a different value, and accepting it would credit another record's sender, time and text
    // to the identifier that was asked about.
    expect(carriesEveryExactTerm("P4B-A-1349.2 的发送者", ["p4b-a-1349"])).toBe(false);
    expect(carriesEveryExactTerm("order_123-2 已处理", ["order_123"])).toBe(false);
  });

  it("carries nothing when the query named no identifier", () => {
    expect(carriesEveryExactTerm("deploy rollback", [])).toBe(true);
  });
});

describe("whether the whole message is the identifier", () => {
  it("accepts case, width and surrounding whitespace differences", () => {
    expect(isBareExactTerm("  P4B-A-1349\n", "p4b-a-1349")).toBe(true);
    expect(isBareExactTerm("Ｐ４Ｂ－Ａ－１３４９", "p4b-a-1349")).toBe(true);
  });

  it("rejects commentary that merely contains the identifier", () => {
    expect(isBareExactTerm("已找到 P4B-A-1349", "p4b-a-1349")).toBe(false);
    expect(isBareExactTerm("P4B-A-1349 已合并", "p4b-a-1349")).toBe(false);
  });
});

describe("the two sides of a containment search", () => {
  it("read one boundary rule, so a query matches the text it literally is", () => {
    // The property that makes containment trustworthy, stated without naming a mechanism: a
    // message carrying the query's own text must be found. It held for `P4B-A-1349` and broke
    // for every shape where the value ends the sentence, because the query side stripped the
    // separator and the candidate side counted it as part of the value. Stating it this way
    // fails on that whole class rather than on the one punctuation mark that was noticed.
    for (const text of [
      "P4B-A-1349",
      "见 P4B-A-1349.",
      "编号：P4B-A-1349.",
      "P4B-A-1349_",
      "订单 order_123. 已处理",
      "order_123_",
      "v1.2.3.",
      "1234567890.",
      "P4B-A-1349 和 order_123 都在",
      "P4B-A-１３４９",
      "Ｐ4B-A-1349",
      "见 Ｐ4B-A-1349。",
      "订单 ｏｒｄｅｒ＿１２３ 已处理",
    ]) {
      const terms = exactTerms(text);
      expect(terms, text).not.toEqual([]);
      expect(carriesEveryExactTerm(text, terms), text).toBe(true);
    }
  });
});
