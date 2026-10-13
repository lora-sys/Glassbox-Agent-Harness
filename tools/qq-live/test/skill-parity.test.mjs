import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { verifyCore as verifyAgentsCore } from "../../../.agents/skills/qq-live-testing/scripts/verify-core.mjs";
import { verifyCore as verifyClaudeCore } from "../../../.claude/skills/qq-live-testing/scripts/verify-core.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(relative, entry.name);
      return entry.isDirectory() ? filesUnder(root, child) : [child];
    }),
  );
  return nested.flat().sort();
}

async function assertMirroredSkill(skillName) {
  const agentsRoot = path.join(repositoryRoot, ".agents", "skills", skillName);
  const claudeRoot = path.join(repositoryRoot, ".claude", "skills", skillName);
  const [agentsFiles, claudeFiles] = await Promise.all([
    filesUnder(agentsRoot),
    filesUnder(claudeRoot),
  ]);
  assert.deepEqual(claudeFiles, agentsFiles, `${skillName} mirror file list differs`);
  await Promise.all(
    agentsFiles.map(async (relative) => {
      const [agentsContent, claudeContent] = await Promise.all([
        readFile(path.join(agentsRoot, relative), "utf8"),
        readFile(path.join(claudeRoot, relative), "utf8"),
      ]);
      assert.equal(
        claudeContent.replace(/\r\n/g, "\n"),
        agentsContent.replace(/\r\n/g, "\n"),
        `${skillName}/${relative} differs between .agents and .claude`,
      );
    }),
  );
}

test("shared operational skills remain in parity", async () => {
  await assertMirroredSkill("glassbox-ops");
  await assertMirroredSkill("qq-live-testing");
});

test("QQ live testing skill runbooks stay in sync", async () => {
  const [agentsHash, claudeHash] = await Promise.all([verifyAgentsCore(), verifyClaudeCore()]);
  assert.match(agentsHash, /^[a-f0-9]{64}$/u);
  assert.equal(claudeHash, agentsHash);
});
