import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import { getRepoRoot, getServiceDataDir } from "../platform/paths.js";
import { requireIdentifier } from "../identity/scope.js";

export type WorkspaceAccess = "read" | "write";
export interface WorkspaceRecord {
  id: string;
  label: string;
  canonicalPath: string;
  kind: "default" | "registered";
  ownerPrincipalId: string;
  grants: Record<string, WorkspaceAccess>;
  createdAt: string;
}

export interface WorkspaceSummary {
  id: string;
  label: string;
  kind: WorkspaceRecord["kind"];
  access: WorkspaceAccess;
  selected: boolean;
}

interface RegistryState {
  version: 1;
  workspaces: Record<string, WorkspaceRecord>;
  selected: Record<string, string>;
}

export interface WorkspaceRegistryOptions {
  dataRoot: string;
  /** Extra host locations, such as a separately installed Kit or browser profile. */
  forbiddenRoots?: string[];
}

const emptyState = (): RegistryState => ({ version: 1, workspaces: {}, selected: {} });
const clone = (record: WorkspaceRecord): WorkspaceRecord => ({
  ...record,
  grants: { ...record.grants },
});

function checkPrincipal(value: string): void {
  requireIdentifier(value);
  if (!/^[\p{L}\p{N}_.:@-]+$/u.test(value)) throw new Error("Invalid principal ID");
}

function checkWorkspaceId(value: string): void {
  if (
    typeof value !== "string" ||
    !/^(?:default-[a-f0-9]{32}|workspace-[a-f0-9-]{36})$/u.test(value)
  )
    throw new Error("Invalid workspace ID");
}

function contains(parent: string, candidate: string): boolean {
  const base = process.platform === "win32" ? parent.toLowerCase() : parent;
  const target = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function samePath(left: string, right: string): boolean {
  return contains(left, right) && contains(right, left);
}

function absoluteLocalDirectory(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !path.isAbsolute(value) ||
    /^(?:\\\\|\/\/)/u.test(value) ||
    value.includes("\0")
  )
    throw new Error("An absolute local directory is required");
  return path.resolve(value);
}

async function existingRealPath(value: string): Promise<string> {
  const resolved = await realpath(absoluteLocalDirectory(value));
  if (!(await stat(resolved)).isDirectory()) throw new Error("Workspace path is not a directory");
  return resolved;
}

function validateState(value: unknown): RegistryState {
  if (!value || typeof value !== "object") throw new Error("Invalid workspace registry");
  const state = value as Partial<RegistryState>;
  if (
    state.version !== 1 ||
    !state.workspaces ||
    typeof state.workspaces !== "object" ||
    Array.isArray(state.workspaces) ||
    !state.selected ||
    typeof state.selected !== "object" ||
    Array.isArray(state.selected)
  )
    throw new Error("Unsupported workspace registry");
  for (const [id, record] of Object.entries(state.workspaces)) {
    checkWorkspaceId(id);
    if (
      !record ||
      record.id !== id ||
      (record.kind !== "default" && record.kind !== "registered") ||
      typeof record.label !== "string" ||
      typeof record.canonicalPath !== "string" ||
      typeof record.ownerPrincipalId !== "string" ||
      typeof record.createdAt !== "string" ||
      !record.grants ||
      typeof record.grants !== "object" ||
      Array.isArray(record.grants)
    )
      throw new Error("Invalid workspace record");
    absoluteLocalDirectory(record.canonicalPath);
    checkPrincipal(record.ownerPrincipalId);
    for (const [principal, access] of Object.entries(record.grants)) {
      checkPrincipal(principal);
      if (access !== "read" && access !== "write") throw new Error("Invalid workspace grant");
    }
  }
  for (const [principal, id] of Object.entries(state.selected)) {
    checkPrincipal(principal);
    checkWorkspaceId(id);
    if (!state.workspaces[id] || !Object.hasOwn(state.workspaces[id].grants, principal))
      throw new Error("Invalid workspace selection");
  }
  return state as RegistryState;
}

/** Server-owned metadata. This registry does not enforce a filesystem sandbox. */
export class WorkspaceRegistry {
  private readonly root: string;
  private readonly file: string;
  private readonly anchor: string;
  private readonly forbidden: string[];

  private constructor(root: string, forbidden: string[]) {
    this.root = root;
    this.file = path.join(root, "workspace-registry.json");
    this.anchor = path.join(root, ".workspace-registry-lock");
    this.forbidden = forbidden;
  }

  static async open(options: WorkspaceRegistryOptions): Promise<WorkspaceRegistry> {
    const rootInput = absoluteLocalDirectory(options.dataRoot);
    await mkdir(rootInput, { recursive: true, mode: 0o700 });
    const root = await existingRealPath(rootInput);
    await chmod(root, 0o700);
    const sensitive = [
      getRepoRoot(),
      getServiceDataDir(),
      path.join(homedir(), ".glassbox"),
      path.join(homedir(), ".ssh"),
      path.join(homedir(), ".aws"),
      path.join(homedir(), ".config"),
      path.join(homedir(), ".claude"),
      path.join(homedir(), ".pi"),
      path.join(homedir(), ".codex"),
      ...(options.forbiddenRoots ?? []),
    ];
    const forbidden: string[] = [root];
    for (const item of sensitive) {
      const absolute = absoluteLocalDirectory(item);
      try {
        forbidden.push(await existingRealPath(absolute));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        forbidden.push(absolute);
      }
    }
    const handle = await open(path.join(root, ".workspace-registry-lock"), "a", 0o600);
    await handle.close();
    return new WorkspaceRegistry(root, forbidden);
  }

  private async read(): Promise<RegistryState> {
    try {
      return validateState(JSON.parse(await readFile(this.file, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  private async save(state: RegistryState): Promise<void> {
    const temp = path.join(this.root, `.workspace-registry-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      const handle = await open(temp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  private async change<T>(operation: (state: RegistryState) => Promise<T>): Promise<T> {
    const release = await lock(this.anchor, {
      retries: { retries: 12, minTimeout: 20, maxTimeout: 150 },
    });
    try {
      const state = await this.read();
      const result = await operation(state);
      await this.save(state);
      return result;
    } finally {
      await release();
    }
  }

  private assertImportAllowed(candidate: string): void {
    if (this.forbidden.some((item) => contains(item, candidate) || contains(candidate, item)))
      throw new Error("Protected host directory cannot be registered");
    if (samePath(path.parse(candidate).root, candidate))
      throw new Error("Filesystem root cannot be registered");
  }

  /** Called after identity resolution has established an Owner principal. */
  async ensureDefault(principalId: string): Promise<WorkspaceRecord> {
    checkPrincipal(principalId);
    const id = `default-${createHash("sha256").update(principalId).digest("hex").slice(0, 32)}`;
    return this.change(async (state) => {
      const existing = state.workspaces[id];
      if (existing) {
        if (existing.ownerPrincipalId !== principalId || existing.kind !== "default")
          throw new Error("Default workspace identity conflict");
        await this.verifyPath(existing);
        return clone(existing);
      }
      const directory = path.join(this.root, "workspaces", id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const canonicalPath = await existingRealPath(directory);
      if (!contains(this.root, canonicalPath))
        throw new Error("Default workspace escaped data root");
      await chmod(canonicalPath, 0o700);
      const record: WorkspaceRecord = {
        id,
        label: "Default workspace",
        canonicalPath,
        kind: "default",
        ownerPrincipalId: principalId,
        grants: { [principalId]: "write" },
        createdAt: new Date().toISOString(),
      };
      state.workspaces[id] = record;
      if (!Object.hasOwn(state.selected, principalId))
        Object.defineProperty(state.selected, principalId, {
          value: id,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      return clone(record);
    });
  }

  /** Only a trusted management caller may supply this host path. */
  async registerExistingTrusted(input: {
    path: string;
    label: string;
    ownerPrincipalId: string;
  }): Promise<WorkspaceRecord> {
    checkPrincipal(input.ownerPrincipalId);
    if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 120)
      throw new Error("Invalid workspace label");
    const canonicalPath = await existingRealPath(input.path);
    this.assertImportAllowed(canonicalPath);
    await access(canonicalPath, constants.R_OK);
    return this.change(async (state) => {
      for (const item of Object.values(state.workspaces)) {
        if (samePath(item.canonicalPath, canonicalPath))
          throw new Error("Workspace is already registered");
      }
      const id = `workspace-${randomUUID()}`;
      const record: WorkspaceRecord = {
        id,
        label: input.label.trim(),
        canonicalPath,
        kind: "registered",
        ownerPrincipalId: input.ownerPrincipalId,
        grants: { [input.ownerPrincipalId]: "write" },
        createdAt: new Date().toISOString(),
      };
      state.workspaces[id] = record;
      return clone(record);
    });
  }

  /** Trusted management operation. Default private workspaces cannot be shared. */
  async grantTrusted(
    workspaceId: string,
    principalId: string,
    accessLevel: WorkspaceAccess,
  ): Promise<void> {
    checkWorkspaceId(workspaceId);
    checkPrincipal(principalId);
    if (accessLevel !== "read" && accessLevel !== "write")
      throw new Error("Invalid workspace access");
    await this.change(async (state) => {
      const record = state.workspaces[workspaceId];
      if (!record || record.kind === "default") throw new Error("Workspace cannot be shared");
      await this.verifyPath(record);
      Object.defineProperty(record.grants, principalId, {
        value: accessLevel,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });
  }

  /** Revocation changes one principal's grant without removing other grants. */
  async revokeTrusted(workspaceId: string, principalId: string): Promise<void> {
    checkWorkspaceId(workspaceId);
    checkPrincipal(principalId);
    await this.change(async (state) => {
      const record = state.workspaces[workspaceId];
      if (!record || record.kind === "default" || record.ownerPrincipalId === principalId)
        throw new Error("Workspace grant cannot be revoked");
      delete record.grants[principalId];
      if (Object.hasOwn(state.selected, principalId) && state.selected[principalId] === workspaceId)
        delete state.selected[principalId];
    });
  }

  /** This is safe for model-requested selection only after caller identity is server bound. */
  async select(principalId: string, workspaceId: string): Promise<void> {
    checkPrincipal(principalId);
    checkWorkspaceId(workspaceId);
    await this.change(async (state) => {
      const record = state.workspaces[workspaceId];
      if (!record || !Object.hasOwn(record.grants, principalId))
        throw new Error("Workspace access denied");
      await this.verifyPath(record);
      Object.defineProperty(state.selected, principalId, {
        value: workspaceId,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });
  }

  private async verifyPath(record: WorkspaceRecord): Promise<void> {
    let current: string;
    try {
      current = await existingRealPath(record.canonicalPath);
    } catch {
      throw new Error("Workspace path unavailable");
    }
    if (!samePath(current, record.canonicalPath)) throw new Error("Workspace path changed");
    if (record.kind === "default") {
      if (!contains(path.join(this.root, "workspaces"), current))
        throw new Error("Default workspace escaped data root");
    } else this.assertImportAllowed(current);
  }

  async resolveAuthorized(
    principalId: string,
    workspaceId: string,
    requiredAccess: WorkspaceAccess,
  ): Promise<WorkspaceRecord> {
    checkPrincipal(principalId);
    checkWorkspaceId(workspaceId);
    if (requiredAccess !== "read" && requiredAccess !== "write")
      throw new Error("Invalid workspace access");
    const state = await this.read();
    const record = state.workspaces[workspaceId];
    if (
      !record ||
      !Object.hasOwn(record.grants, principalId) ||
      (requiredAccess === "write" && record.grants[principalId] !== "write")
    )
      throw new Error("Workspace access denied");
    await this.verifyPath(record);
    return clone(record);
  }

  async resolveSelected(
    principalId: string,
    requiredAccess: WorkspaceAccess = "read",
  ): Promise<WorkspaceRecord> {
    checkPrincipal(principalId);
    const state = await this.read();
    const selected = state.selected[principalId];
    if (!Object.hasOwn(state.selected, principalId) || !selected)
      throw new Error("No workspace selected");
    return this.resolveAuthorized(principalId, selected, requiredAccess);
  }

  async listForPrincipal(principalId: string): Promise<WorkspaceSummary[]> {
    checkPrincipal(principalId);
    const state = await this.read();
    return Object.values(state.workspaces)
      .filter((item) => Object.hasOwn(item.grants, principalId))
      .map((item) => ({
        id: item.id,
        label: item.label,
        kind: item.kind,
        access: item.grants[principalId],
        selected: state.selected[principalId] === item.id,
      }));
  }
}
