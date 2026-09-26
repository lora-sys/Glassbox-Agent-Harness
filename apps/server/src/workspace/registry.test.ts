import { mkdtemp, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "./registry.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "glassbox-workspace-test-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const project = join(root, "project");
  const secret = join(root, "secret");
  await Promise.all([mkdir(project), mkdir(secret)]);
  const registry = await WorkspaceRegistry.open({ dataRoot, forbiddenRoots: [secret] });
  return { root, dataRoot, project, secret, registry };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("WorkspaceRegistry", () => {
  it("creates stable private defaults and persists selected IDs", async () => {
    const { dataRoot, registry } = await fixture();
    const first = await registry.ensureDefault("owner-a");
    const second = await registry.ensureDefault("owner-b");
    expect(first.id).not.toBe(second.id);
    expect((await registry.ensureDefault("owner-a")).id).toBe(first.id);
    await expect(registry.resolveAuthorized("owner-b", first.id, "read")).rejects.toThrow("denied");
    const reopened = await WorkspaceRegistry.open({ dataRoot });
    expect((await reopened.resolveSelected("owner-a", "write")).id).toBe(first.id);
    const raw = await readFile(join(dataRoot, "workspace-registry.json"), "utf8");
    expect(JSON.parse(raw).version).toBe(1);
  });

  it("registers trusted paths and keeps grants independent across Owners", async () => {
    const { registry, project } = await fixture();
    const record = await registry.registerExistingTrusted({
      path: project,
      label: "Project",
      ownerPrincipalId: "owner-a",
    });
    await registry.grantTrusted(record.id, "owner-b", "read");
    await registry.select("owner-b", record.id);
    await expect(registry.listForPrincipal("owner-b")).resolves.toEqual([
      {
        id: record.id,
        label: "Project",
        kind: "registered",
        access: "read",
        selected: true,
      },
    ]);
    expect((await registry.resolveSelected("owner-b")).id).toBe(record.id);
    await expect(registry.resolveSelected("owner-b", "write")).rejects.toThrow("denied");
    await registry.revokeTrusted(record.id, "owner-b");
    await expect(registry.resolveSelected("owner-b")).rejects.toThrow("No workspace selected");
    expect((await registry.resolveAuthorized("owner-a", record.id, "write")).id).toBe(record.id);
    await expect(registry.select("owner-b", record.id)).rejects.toThrow("denied");
    await expect(
      registry.grantTrusted((await registry.ensureDefault("owner-a")).id, "owner-b", "read"),
    ).rejects.toThrow("cannot be shared");
  });

  it("rejects protected roots, ancestors, and symlink aliases", async () => {
    const { root, secret, registry } = await fixture();
    await expect(
      registry.registerExistingTrusted({
        path: secret,
        label: "Secret",
        ownerPrincipalId: "owner-a",
      }),
    ).rejects.toThrow("Protected");
    await expect(
      registry.registerExistingTrusted({
        path: root,
        label: "Ancestor",
        ownerPrincipalId: "owner-a",
      }),
    ).rejects.toThrow("Protected");
    const alias = join(root, "alias");
    await symlink(secret, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(
      registry.registerExistingTrusted({
        path: alias,
        label: "Alias",
        ownerPrincipalId: "owner-a",
      }),
    ).rejects.toThrow("Protected");
  });

  it("rejects path replacement before resolution", async () => {
    const { root, project, secret, registry } = await fixture();
    const record = await registry.registerExistingTrusted({
      path: project,
      label: "Project",
      ownerPrincipalId: "owner-a",
    });
    await rename(project, join(root, "old-project"));
    await symlink(secret, project, process.platform === "win32" ? "junction" : "dir");
    await expect(registry.resolveAuthorized("owner-a", record.id, "read")).rejects.toThrow(
      "changed",
    );
  });

  it("serializes concurrent metadata writes", async () => {
    const { dataRoot, registry, project } = await fixture();
    const record = await registry.registerExistingTrusted({
      path: project,
      label: "Project",
      ownerPrincipalId: "owner-a",
    });
    const another = await WorkspaceRegistry.open({ dataRoot });
    await Promise.all([
      registry.grantTrusted(record.id, "owner-b", "read"),
      another.grantTrusted(record.id, "owner-c", "write"),
    ]);
    expect((await registry.resolveAuthorized("owner-b", record.id, "read")).id).toBe(record.id);
    expect((await another.resolveAuthorized("owner-c", record.id, "write")).id).toBe(record.id);
  });

  it("does not treat inherited object keys as grants", async () => {
    const { registry, project } = await fixture();
    const record = await registry.registerExistingTrusted({
      path: project,
      label: "Project",
      ownerPrincipalId: "owner-a",
    });
    await expect(registry.resolveAuthorized("toString", record.id, "read")).rejects.toThrow(
      "denied",
    );
    await expect(registry.select("__proto__", record.id)).rejects.toThrow("denied");
    await registry.grantTrusted(record.id, "__proto__", "read");
    await registry.select("__proto__", record.id);
    expect((await registry.resolveSelected("__proto__")).id).toBe(record.id);
  });
});
