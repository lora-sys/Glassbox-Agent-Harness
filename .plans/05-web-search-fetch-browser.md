# Issue 20: Web Search, Fetch, and Browser Foundation

Status: ACTIVE. The Exa and Jev slice exists on this branch. The agent-browser implementation and Issue #23 sandbox are joined on local Issue #20 branches. Remaining external acceptance is listed below.
Base: `origin/main` at `2aff988`, merged into `codex/issue-20-web-foundation` after PR #22.
Issue: https://github.com/lora-sys/Glassbox-Agent-Harness/issues/20
Dependency: https://github.com/lora-sys/Glassbox-Agent-Harness/issues/23

## Architecture decision

The Personal Agent exposes `web_search`, `web_fetch`, and `browser`. The browser backend is a pinned `agent-browser` and Chromium installation. The protected `browser` tool and the Owner's authorized sandbox Shell use the same #23 execution session, installation, isolation policy, cancellation, output and Artifact contract. Glassbox checks product authorization for every protected action. Neither path may launch a browser from the Glassbox host process or fall back to host execution.

The previous Docker plus Playwright CLI runner, proxy sidecar, command mapping, Skill, and provider-specific tool name were removed. Existing Playwright test infrastructure remains. The #23 sandbox owns the OS file and network boundary; Issue #20 owns browser action semantics, source evidence, and Web policy. The shared interface opens an authorized isolated session, executes a fixed CLI with structured argv, returns bounded text or protected Artifact, cancels, and closes. The session binds Principal, Run or TaskAttempt, workspace Resource, and immutable policy version. Missing backend means unavailable, never host fallback.

## Ordered work

1. Preserve and validate the working Exa MCP Search and Contents, deterministic Jev fallback, URL normalization, source IDs, and protected `web_search` and `web_fetch` while integrating PR #22's modularized entry and tests. Do not turn Jev ranking into factual confidence. Reject filters that cannot be honored instead of silently ignoring them.
2. Fix capability semantics: `web.search`, `web.fetch`, `browser.read`, and `browser.interact` remain separate. Browser search fallback checks both browser capabilities before fill, press, or click. A missing capability yields `fallback_denied`; CAPTCHA and rate limits yield `blocked`, not zero results. Recheck current policy before every action and after revocation.
3. Replace Playwright CLI-specific contracts with a versioned `agent-browser` action mapping. The public tool name is `browser`; its schema is a strict allowlist without raw argv, eval, nested batch, route mutation, profile import, uploads, arbitrary headers, plugins, chat, MCP, or external attach. Snapshot references bind session, tab, and page state. Read, wait, screenshot, network observation, and interaction have real result and post-state semantics.
4. Route both protected browser calls and Owner sandbox Shell through #23's single executor. Browser search and fetch fallback reuse that session with bounded steps, network policy, cancellation, cleanup, and Artifact storage. No separate Docker process manager remains in #20.
5. Replace `lora-sys/skills/playwright-cli` with a complete version-pinned `lora-sys/skills/agent-browser` core Skill and provenance; synchronize it into a pinned Lora PI Kit snapshot; update Glassbox's Kit reference and runtime capability records. A no-exec Principal can read the Skill without running CLI.
6. Run focused tests, repository full gate, real public Exa and browser checks, then joint #20/#23 QQ, multiple Owner, revocation, restart, cancellation, file/network, and Artifact acceptance. Keep every unmet real gate unchecked.

## Version and source checks

- `vercel-labs/agent-browser` source review anchor `d01253d9db28d75080e36da3c1c31ef89454731e`, Apache-2.0. Match the implementation to a verified published CLI and Skill payload, rather than assuming the source commit equals the npm package.
- Jev Search `67027d0185a9b22eb2a178f0eb15250d12ddabe6`, MIT. Search1API stays reference only.
- OpenHarness URL guard `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`, MIT. Local URL checks are not proof of Exa's server-side redirect behavior or a substitute for #23 network isolation.
- Exa Search and Contents contracts: https://exa.ai/docs/reference/search and https://exa.ai/docs/reference/get-contents. The keyless hosted MCP is preferred while available, without a promised fixed quota.
- The Glassbox agent-browser Skill is committed at `lora-sys/skills` `cd295366c1dbfc3114eb7e351ea68642d4526dbf`. Lora PI Kit snapshots it in the local integration commit `513063950dc0d9dcd4835d6fcc79814728e98b35`, which `kit-loader.ts` pins. The runtime CLI target is published `agent-browser` `0.38.1`. Kit locks the local Docker image `sha256:611f74c5d4e7c4b2f9819ad5874bb7e1ea7fea2cf3807b2cdb90d0f6c04d2f6d`.

## Current evidence and open gates

- Previous branch verification passed 1214 unit, 57 end-to-end, and 93 regression tests plus web build before the upstream merge. These counts do not verify the new architecture.
- Real Exa hosted MCP Search and Contents worked. The supplied Jev credential returned HTTP 401; live Jev acceptance is open.
- Previous isolated Playwright CLI opened a public page and rejected a redirect to `169.254.169.254`. That result does not verify agent-browser or the #23 shared sandbox.
- Browser search fallback was blocked by CAPTCHA or rate limits on tested public engines. Real fallback acceptance remains open.
- Issue #23 Harness PR #25 and Kit PR #2 were imported into the two local Issue #20 worktrees without merging either PR into `main`. The shared browser and Shell session, controlled `public_web` egress, screenshot Artifact storage and read route are implemented. Kit's final Docker smoke passed all eight native tools, system DNS fake-IP denial, explicit encrypted DNS public browser navigation and snapshot, PNG Artifact, cancellation, and recovery. Harness's real Docker smoke passed public browser navigation and snapshot, private target denial, Screenshot Artifact binding, and authorization revocation.
- Kit's full test suite passed 35 tests. The Harness commit gate passed 1313 unit tests with one existing skipped test. Separate runs passed 71 end-to-end tests, 105 regression tests, the core static check, and the Web build. Joint real QQ and Herdr acceptance remains open.
- The Browser Tool reads the current guarded tab. Direct `read <url>` is excluded because that CLI path can fetch redirected content outside the active-tab URL check. A denied or unsafe navigation closes its session. Kit's proxy enforces the network boundary on each request. The default DNS mode fails closed when this host returns fake IP addresses; `cloudflare_doh` is an explicit deployment option with fixed resolvers and public-address validation.
