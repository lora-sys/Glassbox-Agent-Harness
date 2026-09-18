# P3 verification status

P3 remains incomplete. Keep Issue 1 open and PR 4 in Draft on `codex/p3-personal-agent-foundation`. The frontend worktree is separate.

## Latest host checks

- `npm run test:server`: 792 passed, one opt-in Herdr test skipped. This root command includes server and management web tests.
- Server TypeScript check passed.
- Changed server and contracts TypeScript files passed strict `vp lint --deny-warnings`.
- Changed server and contracts files were formatted. Root `npm run check` still fails on unrelated baseline formatting. The measured list had 194 entries, including one new prompt fixture which was subsequently formatted. No frontend files were changed to clear this baseline.
- Actual Pi SDK with actual Kit passed eight integration checks. These include main-agent, qq-group and test profiles, Ops delegation/rework/accept using FakeHerdrBridge, and protected Tools with both local and real stdio MCP execution. Both granted and denied MCP paths were exercised through Glassbox authorization before the transport call.
- Pi turn evidence now includes actual provider/model and input/output/cache/total token counts. Missing measurements are not replaced with invented zeroes.
- Three adapter unit tests now use repository fixtures instead of a sibling Kit checkout.

## Kit transport correction

The real MCP test exposed premature shutdown completion on Windows. Kit `StdioMcpClient.stop` now waits for the child close event, drains stderr and handles stdin errors. A regression test removes the child working directory immediately after stop without sleep or retry.

Kit build passed and 21 tests passed. Commit `870a025775f28e314eeef974aa09511802f3e3d2` was pushed to the Kit P3 branch and is the configured Glassbox pin. A new tarball was installed in the independent npm consumer with a fresh isolated agent directory. The installed package loaded its locked unslop Skill and executed the real stdio MCP fixture through Pi. Evidence is `kit-artifact-evidence-870a025.json` in the isolated integration directory. The earlier artifact and evidence remain separate.

## Remaining real acceptance

The connected QQ acceptance instance uses separate Bot, Owner and Visitor accounts and the configured test group. Account identifiers remain in local acceptance configuration. Its durable state still showed 32 successful Runs and no Tasks at the latest check. The Owner has been asked to send the explicit private delegation task. Do not manufacture that QQ event or present a fixture as a real account action.

The real separate Herdr fixture previously completed a Pi Task with two attempts and explicit acceptance. The combined production QQ Task path still needs delegation, REVIEW, Rework, a second TaskAttempt, Accept and gated QQ delivery, followed by restart/reconnect/dedupe/security evidence. See the active Plan for the full completion gate.
