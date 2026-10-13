import test from "node:test";
import assert from "node:assert/strict";
import { verifyCore as verifyAgentsCore } from "../../../.agents/skills/qq-live-testing/scripts/verify-core.mjs";
import { verifyCore as verifyClaudeCore } from "../../../.claude/skills/qq-live-testing/scripts/verify-core.mjs";

test("QQ live testing skill runbooks stay in sync", async () => {
  const [agentsHash, claudeHash] = await Promise.all([verifyAgentsCore(), verifyClaudeCore()]);
  assert.match(agentsHash, /^[a-f0-9]{64}$/u);
  assert.equal(claudeHash, agentsHash);
});
