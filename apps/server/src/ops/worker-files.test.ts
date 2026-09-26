import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  link,
  symlink,
  rename,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { WorkerFiles } from "./worker-files.js";

it("bounds file access and rejects traversal, private metadata, links and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-files-"));
  const root = join(directory, "workspace");
  await mkdir(root);
  try {
    await writeFile(join(directory, "private.txt"), "PRIVATE_CANARY");
    const files = await WorkerFiles.open(root);
    await files.write("src/sum.ts", "export const sum = (a, b) => a + b;");
    expect(await files.read("src/sum.ts")).toContain("export const sum");
    await files.write("src/sum.ts", "short");
    expect(await files.read("src/sum.ts")).toBe("short");
    for (const path of [
      "../private.txt",
      ".git/config",
      ".pi/settings.json",
      "node_modules/module.js",
      "C:/private.txt",
      "src\\escape",
      "src/file:stream",
      "src/CON",
      "src/../private.txt",
      "src/name.",
    ]) {
      await expect(files.read(path)).rejects.toThrow();
      await expect(files.write(path, "overwrite")).rejects.toThrow();
    }
    await link(join(directory, "private.txt"), join(root, "hardlink.txt"));
    await expect(files.read("hardlink.txt")).rejects.toThrow();
    await expect(files.write("hardlink.txt", "overwrite")).rejects.toThrow();
    await mkdir(join(directory, "outside"));
    await writeFile(join(directory, "outside", "secret.txt"), "PRIVATE_CANARY");
    await symlink(
      join(directory, "outside"),
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(files.read("linked/secret.txt")).rejects.toThrow();
    await expect(files.write("linked/secret.txt", "overwrite")).rejects.toThrow();
    await writeFile(join(root, "large.txt"), "x".repeat(262145));
    await expect(files.read("large.txt")).rejects.toThrow();
    expect(await files.list()).toEqual(["large.txt", "src/sum.ts"]);
    expect(await readFile(join(directory, "private.txt"), "utf8")).toBe("PRIVATE_CANARY");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a directory replaced by a symlink between path validation and open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-files-race-"));
  const root = join(directory, "workspace");
  const victim = join(root, "victim");
  const saved = join(root, "saved-victim");
  const outside = join(directory, "outside");
  await mkdir(victim, { recursive: true });
  await mkdir(outside);
  await writeFile(join(victim, "secret.txt"), "inside");
  await writeFile(join(outside, "secret.txt"), "PRIVATE_CANARY");

  const raceOnce = async () => {
    let raced = false;
    return WorkerFiles.open(root, {
      beforeOpen: async (path) => {
        if (path !== "victim/secret.txt" || raced) return;
        raced = true;
        await rename(victim, saved);
        await symlink(outside, victim, process.platform === "win32" ? "junction" : "dir");
      },
    });
  };

  try {
    await expect((await raceOnce()).read("victim/secret.txt")).rejects.toThrow();
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("PRIVATE_CANARY");
    await unlink(victim);
    await rename(saved, victim);

    await expect((await raceOnce()).write("victim/secret.txt", "overwrite")).rejects.toThrow();
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("PRIVATE_CANARY");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not adopt a root replaced by a symlink or list names from an external directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-files-list-race-"));
  const root = join(directory, "workspace");
  const savedRoot = join(directory, "saved-workspace");
  const victim = join(root, "victim");
  const savedVictim = join(root, "saved-victim");
  const outside = join(directory, "outside");
  await mkdir(victim, { recursive: true });
  await mkdir(outside);
  await writeFile(join(victim, "inside.txt"), "inside");
  await writeFile(join(outside, "external-name.txt"), "outside");

  try {
    await expect(
      WorkerFiles.open(root, {
        beforeOpen: async (path) => {
          if (path !== ".") return;
          await rename(root, savedRoot);
          await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
        },
      }),
    ).rejects.toThrow();
    await unlink(root);
    await rename(savedRoot, root);

    let raced = false;
    const files = await WorkerFiles.open(root, {
      beforeOpen: async (path) => {
        if (path !== "victim" || raced) return;
        raced = true;
        await rename(victim, savedVictim);
        await symlink(outside, victim, process.platform === "win32" ? "junction" : "dir");
      },
    });
    await expect(files.list()).rejects.toThrow();
    await unlink(victim);
    await rename(savedVictim, victim);
    expect(await files.list()).toEqual(["victim/inside.txt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
