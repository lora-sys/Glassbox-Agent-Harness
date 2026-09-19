import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export interface GroupRuntimeProfile {
  connectionId: string;
  groupId: string;
  enabledSkills: string[];
  version: number;
  updatedByPrincipalId: string | null;
  updatedAt: string | null;
}

interface Settings {
  version: 1;
  groups: GroupRuntimeProfile[];
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u.test(value))
    throw new Error(`Invalid ${field}`);
  return value;
}

function groupId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,15}$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("Invalid QQ group number");
  return value;
}

function skillName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value))
    throw new Error("Invalid Skill name");
  return value;
}

function parseProfile(value: unknown): GroupRuntimeProfile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid group runtime profile");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "connectionId",
          "groupId",
          "enabledSkills",
          "version",
          "updatedByPrincipalId",
          "updatedAt",
        ].includes(key),
    ) ||
    !Array.isArray(input.enabledSkills) ||
    input.enabledSkills.length > 128 ||
    !Number.isSafeInteger(input.version) ||
    (input.version as number) < 1 ||
    (input.updatedByPrincipalId !== null && typeof input.updatedByPrincipalId !== "string") ||
    (input.updatedAt !== null &&
      (typeof input.updatedAt !== "string" || Number.isNaN(Date.parse(input.updatedAt))))
  )
    throw new Error("Invalid group runtime profile");
  const enabledSkills = [...new Set(input.enabledSkills.map(skillName))].sort();
  return {
    connectionId: identifier(input.connectionId, "connection identifier"),
    groupId: groupId(input.groupId),
    enabledSkills,
    version: input.version as number,
    updatedByPrincipalId:
      input.updatedByPrincipalId === null
        ? null
        : identifier(input.updatedByPrincipalId, "Principal identifier"),
    updatedAt: input.updatedAt as string | null,
  };
}

function parseSettings(raw: string): Settings {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.groups) || value.groups.length > 1_000)
    throw new Error("Invalid group runtime configuration");
  const groups = value.groups.map(parseProfile);
  const keys = groups.map((profile) => `${profile.connectionId}\0${profile.groupId}`);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate group runtime profile");
  return { version: 1, groups };
}

async function atomicWrite(path: string, settings: Settings): Promise<void> {
  const temporary = join(dirname(path), `.group-runtime-${randomUUID()}.tmp`);
  const previous = `${path}.previous`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(settings, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await unlink(previous).catch(() => undefined);
      await rename(path, previous);
      try {
        await rename(temporary, path);
        await unlink(previous).catch(() => undefined);
      } catch (replacementError) {
        await rename(previous, path).catch(() => undefined);
        throw replacementError;
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class GroupRuntimeStore {
  #settings: Settings;
  #path: string;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(path: string, settings: Settings) {
    this.#path = path;
    this.#settings = settings;
  }

  static async open(dataDirectory: string): Promise<GroupRuntimeStore> {
    if (!isAbsolute(dataDirectory)) throw new Error("Data directory must be absolute");
    const path = join(dataDirectory, "group-runtime.json");
    try {
      if ((await stat(path)).size > 2 * 1024 * 1024)
        throw new Error("Group runtime configuration is too large");
      return new GroupRuntimeStore(path, parseSettings(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return new GroupRuntimeStore(path, { version: 1, groups: [] });
      throw error;
    }
  }

  get(
    connectionIdValue: string,
    groupIdValue: string,
    defaultSkills: readonly string[] = [],
  ): GroupRuntimeProfile {
    const connectionId = identifier(connectionIdValue, "connection identifier");
    const group = groupId(groupIdValue);
    const current = this.#settings.groups.find(
      (profile) => profile.connectionId === connectionId && profile.groupId === group,
    );
    return current
      ? structuredClone(current)
      : {
          connectionId,
          groupId: group,
          enabledSkills: [...new Set(defaultSkills.map(skillName))].sort(),
          version: 0,
          updatedByPrincipalId: null,
          updatedAt: null,
        };
  }

  setSkillEnabled(input: {
    connectionId: string;
    groupId: string;
    skillName: string;
    enabled: boolean;
    availableSkills: readonly string[];
    defaultSkills?: readonly string[];
    principalId: string;
  }): Promise<GroupRuntimeProfile> {
    const available = new Set(input.availableSkills.map(skillName));
    const skill = skillName(input.skillName);
    if (!available.has(skill)) throw new Error("Skill is not available in the active Lora PI Kit");
    if (typeof input.enabled !== "boolean") throw new Error("Invalid Skill state");
    return this.#enqueue(async () => {
      const current = this.get(input.connectionId, input.groupId, input.defaultSkills);
      const enabled = new Set(current.enabledSkills.filter((name) => available.has(name)));
      if (input.enabled) enabled.add(skill);
      else enabled.delete(skill);
      const next = parseProfile({
        ...current,
        enabledSkills: [...enabled],
        version: current.version + 1,
        updatedByPrincipalId: input.principalId,
        updatedAt: new Date().toISOString(),
      });
      const groups = this.#settings.groups.filter(
        (profile) => profile.connectionId !== next.connectionId || profile.groupId !== next.groupId,
      );
      groups.push(next);
      const settings = parseSettings(JSON.stringify({ version: 1, groups }));
      await atomicWrite(this.#path, settings);
      this.#settings = settings;
      return structuredClone(next);
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#tail.catch(() => undefined).then(task);
    this.#tail = operation;
    return operation;
  }
}
