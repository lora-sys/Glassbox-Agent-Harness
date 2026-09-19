import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const LIMIT = 256 * 1024;
const denied = () => new Error("worker_file_scope_denied");

/** No shell, module loading, symlink creation, or process execution is exposed here. */
export class WorkerFiles {
  private constructor(readonly root: string) {}

  static async open(root: string): Promise<WorkerFiles> {
    if (!isAbsolute(root) || !(await lstat(root)).isDirectory()) throw denied();
    return new WorkerFiles(await realpath(root));
  }

  private parts(path: string): string[] {
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 1024 ||
      isAbsolute(path) ||
      /[:\0\\]/u.test(path)
    )
      throw denied();
    const parts = path.split("/");
    if (
      parts.some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) ||
          part === "node_modules",
      )
    )
      throw denied();
    return parts;
  }

  private async target(path: string, createParents = false): Promise<string> {
    const parts = this.parts(path);
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const final = index === parts.length - 1;
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw denied();
        if (final) return current;
        if (!createParents) throw denied();
        await mkdir(current);
        info = await lstat(current);
      }
      if (
        info.isSymbolicLink() ||
        (!final && !info.isDirectory()) ||
        (final && (!info.isFile() || info.nlink !== 1))
      )
        throw denied();
      const local = relative(this.root, await realpath(current));
      if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
        throw denied();
    }
    return current;
  }

  async read(path: string): Promise<string> {
    const file = await open(await this.target(path), constants.O_RDONLY);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT) throw denied();
      const buffer = Buffer.alloc(LIMIT + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > LIMIT) throw denied();
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  }

  async write(path: string, content: string): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content) > LIMIT) throw denied();
    const target = await this.target(path, true);
    let file;
    try {
      file = await open(target, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw denied();
      await this.target(path);
      file = await open(target, "r+");
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw denied();
      await file.writeFile(content, "utf8");
      await file.truncate(Buffer.byteLength(content));
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async list(): Promise<string[]> {
    const result: string[] = [];
    const visit = async (directory: string, depth: number) => {
      if (depth > 8 || result.length >= 1000) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (result.length >= 1000) return;
        const path = relative(this.root, resolve(directory, entry.name)).split(sep).join("/");
        try {
          this.parts(path);
        } catch {
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(join(directory, entry.name), depth + 1);
        else if (entry.isFile() && (await lstat(join(directory, entry.name))).nlink === 1)
          result.push(path);
      }
    };
    await visit(this.root, 0);
    return result.sort();
  }
}
