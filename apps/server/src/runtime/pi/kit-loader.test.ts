import { execFileSync } from "node:child_process";
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

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function gitFixture() {
  const { directory } = await fixture();
  git(directory, "init");
  git(directory, "config", "user.name", "Kit Loader Test");
  git(directory, "config", "user.email", "kit-loader-test@example.invalid");
  git(directory, "add", "-A");
  git(directory, "commit", "-m", "Kit fixture");
  return { directory, commit: git(directory, "rev-parse", "HEAD") };
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

it("validates a Kit Git checkout against the configured commit and clean tree", async () => {
  const { directory, commit } = await gitFixture();
  const loader = new KitLoader(directory, commit);
  const verified = loader.verifyCompatibility("0.85.1");
  expect(verified.compatible).toBe(true);
  expect(verified.details).toMatchObject({
    configuredKitCommit: commit,
    actualKitCommit: commit,
    kitCommitVerified: true,
    kitWorkingTreeClean: true,
    kitSourceType: "git-checkout",
  });
  expect(loader.buildRuntimeConfig("test", directory).kitCommit).toBe(commit);

  const mismatched = new KitLoader(directory, "f".repeat(40)).verifyCompatibility("0.85.1");
  expect(mismatched.compatible).toBe(false);
  expect(mismatched.details).toMatchObject({
    actualKitCommit: commit,
    kitCommitVerified: false,
    kitWorkingTreeClean: true,
  });
});

it("rejects a Git Kit source changed after compatibility verification", async () => {
  const { directory, commit } = await gitFixture();
  const loader = new KitLoader(directory, commit);
  expect(loader.verifyCompatibility("0.85.1").compatible).toBe(true);

  await writeFile(join(directory, "untracked-after-initialize.txt"), "changed");
  expect(() => loader.runtimeEvidence("test")).toThrow(
    "does not match its configured commit or is not clean",
  );

  await rm(join(directory, "untracked-after-initialize.txt"));
  await writeFile(join(directory, "profiles/test.json"), JSON.stringify({ name: "test" }));
  git(directory, "add", "-A");
  git(directory, "commit", "-m", "Changed Kit after initialization");
  expect(() => loader.runtimeEvidence("test")).toThrow(
    "does not match its configured commit or is not clean",
  );
});

it("does not use a parent repository to identify a packaged Kit", async () => {
  const parent = await mkdtemp(join(tmpdir(), "glassbox-kit-parent-repo-"));
  directories.push(parent);
  const directory = join(parent, "lora-pi-kit");
  await mkdir(directory, { recursive: true });
  await cp(fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)), directory, {
    recursive: true,
  });
  git(parent, "init");

  const verified = new KitLoader(directory).verifyCompatibility("0.85.1");
  expect(verified.compatible).toBe(true);
  expect(verified.details).toMatchObject({
    actualKitCommit: null,
    kitCommitVerified: false,
    kitSourceType: "distribution",
  });
});

it("leaves a packaged Kit commit unknown when Git metadata is absent", async () => {
  const { loader } = await fixture();
  const verified = loader.verifyCompatibility("0.85.1");
  expect(verified.compatible).toBe(true);
  expect(verified.details).toMatchObject({
    actualKitCommit: null,
    kitCommitVerified: false,
    kitWorkingTreeClean: null,
    kitSourceType: "distribution",
  });
  expect(loader.runtimeEvidence("test")).toMatchObject({
    actualKitCommit: null,
    configuredKitCommit: expect.any(String),
    kitCommitVerified: false,
  });
  expect(loader.buildRuntimeConfig("test").kitCommit).toBe("unknown");
});

it("lists every Kit profile so profile-selection drift fails before a Run", async () => {
  const { directory, loader } = await fixture();
  await writeFile(
    join(directory, "profiles/brand-new.json"),
    JSON.stringify({ name: "brand-new" }),
  );

  expect(loader.profileNames()).toEqual(["brand-new", "main-agent", "qq-group", "test"]);
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
  expect(prompt).not.toContain("Call skill_read before following a Skill");
  expect(prompt).toContain(
    "Skills are optional procedures. Use skill_read only when a listed Skill clearly applies to the current request.",
  );
  expect(prompt).not.toContain("PRIVATE_SKILL_BODY");
  const emptyPrompt = loader.modelPrompt("test", []);
  expect(emptyPrompt).not.toContain("Available Skills for this Run");
  expect(emptyPrompt).not.toContain("No Skills are available for this Run");
  expect(loader.readSkillFile("fixture")).toContain("PRIVATE_SKILL_BODY");
  expect(() => loader.readSkillFile("fixture", "../private.txt")).toThrow(
    "Invalid Skill file path",
  );
  await writeFile(join(directory, "skills/fixture/SKILL.md"), "Changed content");
  expect(() => loader.runtimeEvidence("test")).toThrow("differs from its lock");
});
