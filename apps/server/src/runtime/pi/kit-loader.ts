import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PiRuntimeProfileName, PiRuntimeConfig } from "./types.js";

export const PINNED_KIT_REPO = "https://github.com/lora-sys/lora-pi-kit";
export const PINNED_KIT_COMMIT = "d71e9d841e80b3370f043490e0f9f610ae487b79";
export const PINNED_PI_VERSION = "0.85.1";

export interface ResolvedKitProfile {
  name: PiRuntimeProfileName;
  description: string;
  promptTemplate: string;
  thinkingLevel: "none" | "low" | "medium" | "high";
  enabledExtensions: string[];
  enabledSkills: string[];
  enabledMcpServers: string[];
  activeTools: string[];
  runtimeIsolation?: {
    defaultAgentDirSubpath?: string;
    isolateSessionState: boolean;
    disposable?: boolean;
  };
}

interface SkillLockEntry {
  path: string;
  sha256: string;
  bytes: number;
}

interface SkillLock {
  sourceCommit: string;
  includedSkills: string[];
  skills: Record<string, { name: string; description: string; files: SkillLockEntry[] }>;
}

export class KitLoader {
  private kitPath: string;

  constructor(customKitPath?: string) {
    if (customKitPath) {
      this.kitPath = path.resolve(customKitPath);
    } else if (process.env.LORA_PI_KIT_PATH) {
      this.kitPath = path.resolve(process.env.LORA_PI_KIT_PATH);
    } else {
      // Test fixtures are only available through an explicit constructor path.
      const siblingPath = path.resolve(process.cwd(), "..", "lora-pi-kit");
      this.kitPath = fs.existsSync(siblingPath)
        ? siblingPath
        : path.resolve(process.cwd(), "lora-pi-kit");
    }
  }

  public getKitPath(): string {
    return this.kitPath;
  }

  private skillLock(): SkillLock {
    const value = JSON.parse(
      fs.readFileSync(path.join(this.kitPath, "locks/skills.lock.json"), "utf8"),
    ) as SkillLock;
    if (
      typeof value.sourceCommit !== "string" ||
      !/^[a-f0-9]{40}$/u.test(value.sourceCommit) ||
      !Array.isArray(value.includedSkills) ||
      value.includedSkills.length > 256 ||
      !value.skills ||
      typeof value.skills !== "object"
    )
      throw new Error("Invalid Kit Skills lock");
    const included = value.includedSkills;
    if (
      included.some(
        (name) => typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name),
      ) ||
      new Set(included).size !== included.length
    )
      throw new Error("Invalid Kit Skills lock");
    for (const name of included) {
      const skill = value.skills[name];
      if (
        !skill ||
        skill.name !== name ||
        typeof skill.description !== "string" ||
        !skill.description.trim() ||
        !Array.isArray(skill.files) ||
        skill.files.length === 0 ||
        skill.files.some(
          (file) =>
            typeof file.path !== "string" ||
            !file.path.startsWith(`skills/${name}/`) ||
            !/^[a-f0-9]{64}$/u.test(file.sha256) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0 ||
            file.bytes > 16 * 1024 * 1024,
        )
      )
        throw new Error("Invalid Kit Skills lock");
    }
    return value;
  }

  public availableSkills(): Array<{ name: string; description: string }> {
    const lock = this.skillLock();
    return lock.includedSkills.map((name) => {
      const skill = lock.skills[name];
      if (
        !skill ||
        skill.name !== name ||
        typeof skill.description !== "string" ||
        !skill.description.trim()
      )
        throw new Error("Invalid locked Skill metadata");
      return { name, description: skill.description };
    });
  }

  /** Only names and descriptions enter the base prompt. Locked files are read on demand. */
  public modelPrompt(profileName: PiRuntimeProfileName, enabledSkills?: readonly string[]): string {
    const selected = enabledSkills ?? this.loadProfile(profileName).enabledSkills;
    this.runtimeEvidence(profileName, selected);
    const profile = this.loadProfile(profileName);
    const read = (relative: string) => {
      const resolved = path.resolve(this.kitPath, relative);
      const within = path.relative(this.kitPath, resolved);
      if (within.startsWith("..") || path.isAbsolute(within))
        throw new Error("Kit prompt escapes package");
      return fs
        .readFileSync(resolved, "utf8")
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
        .trim();
    };
    const prompt = read(`prompts/${profile.promptTemplate}.md`);
    if (!prompt) throw new Error("Kit base prompt is empty");
    if (selected.length === 0) return `${prompt}\n\nNo Skills are available for this Run.`;
    const catalog = new Map(this.availableSkills().map((skill) => [skill.name, skill.description]));
    return [
      prompt,
      [
        "Available Skills for this Run:",
        ...selected.map((name) => {
          const description = catalog.get(name);
          if (!description) throw new Error("Kit Skill is not locked");
          return `- ${name}: ${description}`;
        }),
        "Call skill_read before following a Skill. Only request files needed for the current task.",
      ].join("\n"),
    ].join("\n\n");
  }

  public readSkillFile(skillName: string, relativePath = "SKILL.md"): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillName)) throw new Error("Invalid Skill name");
    const normalized = relativePath.replace(/\\/gu, "/");
    if (
      !normalized ||
      normalized.length > 256 ||
      normalized.startsWith("/") ||
      normalized.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid Skill file path");
    const lock = this.skillLock();
    const entryPath = `skills/${skillName}/${normalized}`;
    const entry = lock.skills[skillName]?.files.find((file) => file.path === entryPath);
    if (!entry) throw new Error("Skill file is not locked");
    const resolved = path.resolve(this.kitPath, entryPath);
    const within = path.relative(path.join(this.kitPath, "skills", skillName), resolved);
    if (!within || within.startsWith("..") || path.isAbsolute(within))
      throw new Error("Skill file escapes locked directory");
    const content = fs.readFileSync(resolved);
    if (content.length !== entry.bytes) throw new Error("Kit Skill size differs from its lock");
    if (content.length > 128 * 1024 || content.includes(0))
      throw new Error("Skill file is not readable text");
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== entry.sha256) throw new Error("Kit Skill content differs from its lock");
    return content.toString("utf8");
  }

  public verifyCompatibility(runtimeVersion = PINNED_PI_VERSION): {
    compatible: boolean;
    details: Record<string, unknown>;
  } {
    const lockPath = path.join(this.kitPath, "locks", "compatibility.json");
    const piLockPath = path.join(this.kitPath, "locks", "pi.lock.json");

    if (!fs.existsSync(lockPath) || !fs.existsSync(piLockPath)) {
      return {
        compatible: false,
        details: { error: "Kit lockfiles not found at " + this.kitPath },
      };
    }

    const compat = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    const piLock = JSON.parse(fs.readFileSync(piLockPath, "utf-8"));

    const piVersionMatches =
      piLock.version === PINNED_PI_VERSION &&
      runtimeVersion === PINNED_PI_VERSION &&
      compat.pinnedPiVersion === PINNED_PI_VERSION &&
      Array.isArray(compat.testedPiVersions) &&
      compat.testedPiVersions.includes(runtimeVersion);

    return {
      compatible: piVersionMatches,
      details: {
        kitVersion: compat.kitVersion,
        pinnedPiVersion: compat.pinnedPiVersion,
        piLockVersion: piLock.version,
        runtimeVersion,
        testedPiVersions: compat.testedPiVersions,
      },
    };
  }

  public loadProfile(name: PiRuntimeProfileName): ResolvedKitProfile {
    const profilePath = path.join(this.kitPath, "profiles", `${name}.json`);
    if (!fs.existsSync(profilePath)) {
      throw new Error(`Profile '${name}' not found at ${profilePath}`);
    }

    const raw = fs.readFileSync(profilePath, "utf-8");
    return JSON.parse(raw) as ResolvedKitProfile;
  }

  public resolveAgentDir(profile: ResolvedKitProfile, baseDir?: string): string {
    const root =
      baseDir ??
      (process.env.GLASSBOX_RUNTIME_DIR
        ? path.resolve(process.env.GLASSBOX_RUNTIME_DIR)
        : path.resolve(process.env.HOME || process.env.USERPROFILE || ".", ".glassbox"));

    const subpath = profile.runtimeIsolation?.defaultAgentDirSubpath ?? `pi/${profile.name}`;
    const resolved = path.resolve(root, subpath);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Kit runtime directory escapes isolated root");
    return resolved;
  }

  public runtimeEvidence(
    profileName: PiRuntimeProfileName,
    enabledSkills?: readonly string[],
  ): Record<string, unknown> {
    const profile = this.loadProfile(profileName);
    const selectedSkills = [...new Set(enabledSkills ?? profile.enabledSkills)];
    const files = [
      "locks/compatibility.json",
      "locks/pi.lock.json",
      `profiles/${profileName}.json`,
      `prompts/${profile.promptTemplate}.md`,
      ...profile.enabledExtensions.map((name) => `extensions/${name}.ts`),
    ];
    const fingerprints: Record<string, string> = {};
    let skillsCommit: string | undefined;
    const skillFingerprints: Record<string, string> = {};
    if (selectedSkills.length > 0) {
      const lock = this.skillLock();
      skillsCommit = lock.sourceCommit;
      files.push("locks/skills.lock.json");
      for (const skill of selectedSkills) {
        const entries = lock.skills?.[skill]?.files;
        if (!Array.isArray(entries) || entries.length === 0)
          throw new Error("Kit Skill is not locked");
        if (!entries.some((entry: { path?: unknown }) => entry.path === `skills/${skill}/SKILL.md`))
          throw new Error("Kit Skill entrypoint is not locked");
        for (const entry of entries) {
          if (
            typeof entry.path !== "string" ||
            !entry.path.startsWith(`skills/${skill}/`) ||
            typeof entry.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(entry.sha256)
          )
            throw new Error("Invalid Kit Skill lock");
          const resolved = path.resolve(this.kitPath, entry.path);
          const relative = path.relative(this.kitPath, resolved);
          if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error("Kit resource escapes package");
          const actual = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
          if (actual !== entry.sha256) throw new Error("Kit Skill content differs from its lock");
        }
        skillFingerprints[skill] = createHash("sha256")
          .update(
            entries
              .map((entry: { path: string; sha256: string }) => `${entry.path}:${entry.sha256}`)
              .join("\n"),
          )
          .digest("hex");
      }
    }
    for (const file of files) {
      const resolved = path.resolve(this.kitPath, file);
      const relative = path.relative(this.kitPath, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Kit resource escapes package");
      fingerprints[file] = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
    }
    return {
      profileName,
      piVersion: PINNED_PI_VERSION,
      configuredKitCommit: PINNED_KIT_COMMIT,
      skillsCommit,
      enabledSkills: selectedSkills,
      skillFingerprints,
      fingerprints,
    };
  }

  public buildRuntimeConfig(profileName: PiRuntimeProfileName, baseDir?: string): PiRuntimeConfig {
    const profile = this.loadProfile(profileName);
    const agentDir = this.resolveAgentDir(profile, baseDir);

    return {
      profileName,
      kitPath: this.kitPath,
      kitRepo: PINNED_KIT_REPO,
      kitCommit: PINNED_KIT_COMMIT,
      agentDir,
      allowedTools: profile.activeTools,
      timeoutMs: 30000,
    };
  }
}
