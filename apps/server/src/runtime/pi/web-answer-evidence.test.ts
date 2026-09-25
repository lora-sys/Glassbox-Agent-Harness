import { describe, expect, it } from "vite-plus/test";
import { webAnswerEvidenceFailure, safeWebEvidenceReply } from "./web-answer-evidence.js";

const request = "搜索 Vercel 官方博客最近的文章，核对官网来源和发布日期并附链接";

describe("official source answer evidence", () => {
  it("rejects article links that were not read", () => {
    const failure = webAnswerEvidenceFailure({
      request,
      answer: "已核对两篇文章 https://vercel.com/blog/checked 和 https://vercel.com/blog/unread。",
      toolCalls: [
        {
          name: "web_fetch",
          input: { url: "https://vercel.com/blog/checked" },
          failed: false,
        },
      ],
    });

    expect(failure).toEqual({
      reason: "source_not_read",
      urls: ["https://vercel.com/blog/unread"],
      verifiedUrls: ["https://vercel.com/blog/checked"],
    });
    expect(safeWebEvidenceReply(failure!)).toContain("https://vercel.com/blog/checked");
    expect(safeWebEvidenceReply(failure!)).not.toContain("https://vercel.com/blog/unread");
  });

  it("accepts a citation only when the same URL was fetched successfully", () => {
    expect(
      webAnswerEvidenceFailure({
        request,
        answer: "官方页面：https://vercel.com/blog/checked。",
        toolCalls: [
          {
            name: "web_fetch",
            input: { url: "https://vercel.com/blog/checked/" },
            failed: false,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("withholds an unqualified latest claim and returns only fetched sources", () => {
    expect(
      webAnswerEvidenceFailure({
        request,
        answer: "Vercel 官方博客最新文章是 https://vercel.com/blog/checked。无法证明绝对最新。",
        toolCalls: [
          {
            name: "web_fetch",
            input: { url: "https://vercel.com/blog/checked" },
            failed: false,
          },
        ],
      }),
    ).toEqual({
      reason: "unqualified_latest_claim",
      urls: ["https://vercel.com/blog/checked"],
    });
  });

  it("does not apply to answers that do not claim to verify official sources", () => {
    expect(
      webAnswerEvidenceFailure({
        request: "搜索 Vercel 最近的文章",
        answer: "最新文章是 https://vercel.com/blog/unread。",
        toolCalls: [],
      }),
    ).toBeUndefined();
  });
});
