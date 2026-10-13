import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export function normalizedSha256(content) {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export async function verifyCore(directory = dirname(fileURLToPath(import.meta.url))) {
  const root = join(directory, "..");
  const [core, lock] = await Promise.all([
    readFile(join(root, "core-rules.md"), "utf8"),
    readFile(join(root, "core-rules.sha256"), "utf8"),
  ]);
  const moduleSkillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryRoot = resolve(moduleSkillRoot, "../../..");
  const canonicalRoots = [
    resolve(repositoryRoot, ".agents/skills/qq-live-testing"),
    resolve(repositoryRoot, ".claude/skills/qq-live-testing"),
  ];
  if (canonicalRoots.includes(resolve(root))) {
    const [agentsSkill, claudeSkill] = await Promise.all([
      readFile(join(repositoryRoot, ".agents/skills/qq-live-testing/SKILL.md"), "utf8"),
      readFile(join(repositoryRoot, ".claude/skills/qq-live-testing/SKILL.md"), "utf8"),
    ]);
    if (agentsSkill.replace(/\r\n/g, "\n") !== claudeSkill.replace(/\r\n/g, "\n"))
      throw new Error("QQ live testing skill runbooks differ");
  }
  const match = /^sha256:([a-f0-9]{64})\s*$/i.exec(lock);
  if (!match) throw new Error("Invalid core-rules.sha256 format");
  const actual = normalizedSha256(core);
  if (actual !== match[1].toLowerCase()) throw new Error("Core rules hash mismatch");
  return actual;
}

async function main() {
  try {
    const hash = await verifyCore();
    process.stdout.write(`Core rules verified: sha256:${hash}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
