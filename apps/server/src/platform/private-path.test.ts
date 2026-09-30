import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { securePrivatePath } from "./private-path.js";

const execFile = promisify(execFileCallback);

describe("private path permissions", () => {
  it("restricts an existing directory and file before private content is used", async () => {
    const root = await mkdtemp(join(tmpdir(), "glassbox-private-path-"));
    try {
      const file = join(root, "state.json");
      await writeFile(file, "private-data");
      await securePrivatePath(root, true);
      await securePrivatePath(file, false);
      expect(await readFile(file, "utf8")).toBe("private-data");

      if (process.platform === "win32") {
        for (const path of [root, file]) {
          const { stdout } = await execFile("icacls.exe", [path], { windowsHide: true });
          const entries = stdout.split(/\r?\n/u).filter((line) => /:\([^)]*\)/u.test(line));
          expect(entries).toHaveLength(1);
          expect(entries[0]).toContain("(F)");
          expect(entries[0]).not.toContain("(I)");
        }
      } else {
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
