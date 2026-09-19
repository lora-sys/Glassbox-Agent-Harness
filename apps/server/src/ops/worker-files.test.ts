import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from "node:fs/promises";
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
