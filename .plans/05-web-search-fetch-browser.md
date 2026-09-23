# Issue 20: Web Search, Fetch, and Browser Foundation

Status: IMPLEMENTED, ACCEPTANCE PARTIAL
Base: `feature/16-tool-plane-grounding` at `a226a64`
Issue: https://github.com/lora-sys/Glassbox-Agent-Harness/issues/20

## Goal

Give the Personal Agent three stable, authorized Tools: `web_search`, `web_fetch`, and `playwright_cli`. A current public fact must be supported by a successful Tool call. Search, deep reading, and browser interaction must preserve source and execution evidence while protecting private networks and local state.

## Boundaries

- Keep provider details behind Glassbox Tools. Exa is the primary Search and Contents provider. Use Exa's keyless, rate-limited hosted MCP first as requested; an API key may select the direct REST adapter later. Jev contributes bounded planning and relevance ordering for complex queries. Search1API is not a runtime dependency.
- Use the existing authorization, group capability policy, Tool plane, and RequiredEvidence checks. Browser read and interaction are separate capabilities. Web content cannot authorize actions or become Memory directly.
- Browser sessions are fresh per Run and Principal. Do not expose shell, JavaScript evaluation, local files, personal browser profiles, ambient cookies, or arbitrary uploads.
- This work does not include P5A context budgeting, P5B model routing, or a new UI. No deployment is planned.

## Implementation sequence

1. Freeze contracts and tests for source references, status, partial and truncated results, and capability classes.
2. Port the reviewed OpenHarness URL guard behavior. Check resolved addresses and every redirect or browser navigation, including page initiated requests.
3. Add bounded Exa Search and Contents adapters with distinct missing authentication, quota, timeout, and failure states. Normalize, canonicalize, deduplicate, and preserve Run stable source IDs.
4. Add bounded Jev style query planning, fan out, partial failure, and relevance ranking. Simple queries bypass it. Jev failure falls back to direct Exa.
5. Register `web_search` and `web_fetch` through the protected Tool path and the existing discovery and group policy. Record safe operational metadata.
6. Pin Playwright CLI and its browser runtime. Build a structured argv bridge with an action allowlist, Run scoped session, cleanup, navigation guard, bounded snapshots, and separate read and interaction authorization.
7. Add browser based fetch and search fallback that returns the same source contract when Exa cannot serve the request.
8. Review the official Playwright CLI Skill and provenance in `lora-sys/skills`, then synchronize the pinned Lora PI Kit snapshot. The Skill provides guidance only.
9. Bind current web questions to #16 RequiredEvidence, ensuring failed or unavailable calls cannot support a verified claim.

## Verification

- Focused tests for each contract, status, security boundary, authorization transition, source identity, and fallback state. Tests use disposable data and never weaken existing assertions.
- Run the repository's relevant checks and staged `vp run verify:commit` before any commit.
- Real Exa hosted MCP Search and Contents succeeded without an API key. Jev returned HTTP 401 with the supplied key; the planner's deterministic fallback is covered by tests, but live Jev acceptance remains open.
- The isolated Docker browser opened and read `https://example.com`. A real redirect to `169.254.169.254` was rejected. Direct local/private URLs are also rejected. Public search engines returned CAPTCHA or rate limiting from this host, so live browser Search fallback remains unverified.
- Browser wait, screenshot, downloads, request bodies, and response bodies remain unavailable in the structured bridge. These operations fail explicitly instead of granting filesystem or arbitrary execution access.
- Run the repository's staged `vp run verify:commit` before committing the Harness slice. The Skill and Kit snapshots were separately validated and committed on their own local branches.
- Perform isolated review of the final diff and repeat checks after fixes.

## Reviewed sources

- Exa Search, Contents, and keyless hosted MCP: https://exa.ai/docs/reference/search, https://exa.ai/docs/reference/get-contents, and https://exa.ai/docs/get-started/exa-mcp, reviewed 2026-09-23.
- Jev AI production endpoint: https://thejevai.com/docs, reviewed 2026-09-23. Credentials come from server-side configuration only.
- Jev Search: `superagents-lab/jev-search` at `67027d0185a9b22eb2a178f0eb15250d12ddabe6`, MIT.
- OpenHarness network guard: `HKUDS/OpenHarness` at `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`, MIT.
- Playwright and official CLI Skill: `microsoft/playwright` at `e125b2ff24ad285b22e595f4e01a14f038b2c800`, Apache-2.0. Verify the actual CLI package version and current source path before pinning.
