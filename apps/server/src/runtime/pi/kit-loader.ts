import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PiRuntimeProfileName, PiRuntimeConfig } from "./types.js";

export const PINNED_KIT_REPO = "https://github.com/lora-sys/lora-pi-kit";
export const PINNED_KIT_COMMIT = "870a025775f28e314eeef974aa09511802f3e3d2";
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

  /** Only locked, selected distribution content belongs in model context. */
  public modelPrompt(profileName: PiRuntimeProfileName): string {
    this.runtimeEvidence(profileName);
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
    return [
      prompt,
      ...profile.enabledSkills.map((name) => {
        if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error("Invalid Kit Skill name");
        return `Selected Skill: ${name}\n${read(`skills/${name}/SKILL.md`)}`;
      }),
    ].join("\n\n");
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

  public runtimeEvidence(profileName: PiRuntimeProfileName): Record<string, unknown> {
    const profile = this.loadProfile(profileName);
    const files = [
      "locks/compatibility.json",
      "locks/pi.lock.json",
      `profiles/${profileName}.json`,
      `prompts/${profile.promptTemplate}.md`,
      ...profile.enabledExtensions.map((name) => `extensions/${name}.ts`),
    ];
    const fingerprints: Record<string, string> = {};
    let skillsCommit: string | undefined;
    const expectedHashes = new Map<string, string>();
    if (profile.enabledSkills.length > 0) {
      const lock = JSON.parse(
        fs.readFileSync(path.join(this.kitPath, "locks/skills.lock.json"), "utf8"),
      );
      if (typeof lock.sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(lock.sourceCommit))
        throw new Error("Kit Skills source pin missing");
      skillsCommit = lock.sourceCommit;
      files.push("locks/skills.lock.json");
      for (const skill of profile.enabledSkills) {
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
          files.push(entry.path);
          expectedHashes.set(entry.path, entry.sha256);
        }
      }
    }
    for (const file of files) {
      const resolved = path.resolve(this.kitPath, file);
      const relative = path.relative(this.kitPath, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Kit resource escapes package");
      fingerprints[file] = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
      if (expectedHashes.has(file) && expectedHashes.get(file) !== fingerprints[file])
        throw new Error("Kit Skill content differs from its lock");
    }
    return {
      profileName,
      piVersion: PINNED_PI_VERSION,
      configuredKitCommit: PINNED_KIT_COMMIT,
      skillsCommit,
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
