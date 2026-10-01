# Public web fallback and provider diagnostics

Confirmed audit W1, W2 and W4. Disposable fake BrowserBridge and hosted-MCP caller fixtures; no real provider request, credential or CAPTCHA interaction.

## Reproduction and fix

- Ordinary articles/search results mentioning challenge, CAPTCHA, rate limit or too many requests were falsely classified as blocked. Six tests failed before fixing the fallback slice, including local truncation. Detection now checks explicit interstitial instructions and challenge controls instead of topic words anywhere in a document. This remains a bounded heuristic, not proof that every page is accessible. Actual verification interstitials still return blocked; the change does not solve or bypass one.
- Browser fallback now reports truncation when its own 20,000-character bound clips content, even if the upstream bridge did not clip. Structured BrowserBridge text is decoded before clipping; JSON wrapper length is not mistaken for discarded article content.
- MCP transport HTTP 401/403, 402 and 429 and SDK request-timeout codes were collapsed to failed. Five status tests failed before repair. They now map to existing safe fixed auth_missing, quota_exhausted, rate_limited and timeout categories; 5xx/unknown errors remain failed. Raw error text, URLs and credentials are never emitted, and arbitrary digits in an error message do not determine HTTP status.

## Verification and limits

All 11 existing/new web suites pass, 133 tests. Four additional real protected-Tool regressions first reproduced loss of those categories into generic errors; the Tools now retain fixed safe provider reason codes, without raw error bodies. Changed-file checks and full commit/PR gates are run before publication. This patch does not claim W3 cancellation propagation is fixed; that crosses Tool, planner, provider and browser session contracts and remains a separate change. It does not change search-provider selection, query-filter semantics, authorization, or network guards.
