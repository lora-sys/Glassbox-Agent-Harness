import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vite-plus/test";
import { KitLoader } from "./kit-loader.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-kit-lock-"));
  directories.push(directory);
  await cp(fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)), directory, {
    recursive: true,
  });
  return { directory, loader: new KitLoader(directory) };
}

it("checks the actual Pi version and rejects runtime paths outside the isolated root", async () => {
  const { directory, loader } = await fixture();
  expect(loader.verifyCompatibility("0.85.1").compatible).toBe(true);
  expect(loader.verifyCompatibility("0.85.2").compatible).toBe(false);
  const profile = loader.loadProfile("test");
  profile.runtimeIsolation = {
    defaultAgentDirSubpath: "../../interactive-pi",
    isolateSessionState: true,
  };
  expect(() => loader.resolveAgentDir(profile, directory)).toThrow("escapes isolated root");
});

it("records selected resource fingerprints and rejects a modified locked Skill", async () => {
  const { directory, loader } = await fixture();
  const profilePath = join(directory, "profiles/test.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  profile.enabledSkills = ["fixture"];
  await writeFile(profilePath, JSON.stringify(profile));
  await mkdir(join(directory, "skills/fixture"), { recursive: true });
  const content =
    "---\nname: fixture\ndescription: A test Skill body marker.\n---\n\nPRIVATE_SKILL_BODY";
  await writeFile(join(directory, "skills/fixture/SKILL.md"), content);
  await writeFile(
    join(directory, "locks/skills.lock.json"),
    JSON.stringify({
      sourceCommit: "1".repeat(40),
      includedSkills: ["fixture"],
      skills: {
        fixture: {
          name: "fixture",
          description: "A test Skill body marker.",
          files: [
            {
              path: "skills/fixture/SKILL.md",
              sha256: createHash("sha256").update(content).digest("hex"),
              bytes: Buffer.byteLength(content),
            },
          ],
        },
      },
    }),
  );
  expect(loader.runtimeEvidence("test")).toMatchObject({
    profileName: "test",
    skillsCommit: "1".repeat(40),
    enabledSkills: ["fixture"],
    skillFingerprints: { fixture: expect.stringMatching(/^[a-f0-9]{64}$/u) },
  });
  const prompt = loader.modelPrompt("test");
  expect(prompt).toContain("fixture: A test Skill body marker.");
  expect(prompt).toContain("skill_read");
  expect(prompt).not.toContain("PRIVATE_SKILL_BODY");
  expect(loader.readSkillFile("fixture")).toContain("PRIVATE_SKILL_BODY");
  expect(() => loader.readSkillFile("fixture", "../private.txt")).toThrow(
    "Invalid Skill file path",
  );
  await writeFile(join(directory, "skills/fixture/SKILL.md"), "Changed content");
  expect(() => loader.runtimeEvidence("test")).toThrow("differs from its lock");
});
