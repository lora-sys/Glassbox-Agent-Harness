import { describe, expect, it } from "vite-plus/test";
import { parseBrowserSearchSnapshot } from "./browser-fallback.js";

describe("browser search snapshot parsing", () => {
  it("keeps matching external result links and ignores search navigation", () => {
    const snapshot = `### Page
- Page URL: https://duckduckgo.com/?q=playwright
### Snapshot
- link "DuckDuckGo home" [ref=e1]:
  - /url: https://duckduckgo.com/
- link "Playwright CLI documentation" [ref=e2]:
  - /url: https://playwright.dev/docs/getting-started-cli
- link "Unrelated product" [ref=e3]:
  - /url: https://example.com/
`;
    expect(parseBrowserSearchSnapshot(snapshot, "Playwright docs", 2)).toEqual([
      {
        url: "https://playwright.dev/docs/getting-started-cli",
        title: "Playwright CLI documentation",
        highlights: [],
      },
    ]);
  });

  it("does not turn a CAPTCHA page into search evidence", () => {
    expect(
      parseBrowserSearchSnapshot(
        "Unfortunately, bots use DuckDuckGo too. Complete the challenge.",
        "query",
        5,
      ),
    ).toEqual([]);
  });
});
