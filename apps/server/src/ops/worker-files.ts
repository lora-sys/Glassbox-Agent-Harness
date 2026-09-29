import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const LIMIT = 256 * 1024;
const denied = () => new Error("worker_file_scope_denied");

/** No shell, module loading, symlink creation, or process execution is exposed here. */
export class WorkerFiles {
  private constructor(
    readonly root: string,
    private readonly beforeOpen?: (path: string) => Promise<void>,
  ) {}

  static async open(
    root: string,
    options: { beforeOpen?: (path: string) => Promise<void> } = {},
  ): Promise<WorkerFiles> {
    if (!isAbsolute(root)) throw denied();
    const original = await lstat(root).catch(() => {
      throw denied();
    });
    if (original.isSymbolicLink() || !original.isDirectory()) throw denied();
    await options.beforeOpen?.(".");
    const canonical = await realpath(root).catch(() => {
      throw denied();
    });
    const resolved = await stat(canonical).catch(() => {
      throw denied();
    });
    const current = await lstat(root).catch(() => {
      throw denied();
    });
    const currentCanonical = await realpath(root).catch(() => {
      throw denied();
    });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      canonical !== currentCanonical ||
      original.dev !== resolved.dev ||
      original.ino !== resolved.ino
    )
      throw denied();
    return new WorkerFiles(canonical, options.beforeOpen);
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
    const rootInfo = await lstat(this.root).catch(() => {
      throw denied();
    });
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw denied();
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
    return realpath(current);
  }

  private async directoryTarget(path: string): Promise<string> {
    if (path) this.parts(path);
    let current = this.root;
    const rootInfo = await lstat(current).catch(() => {
      throw denied();
    });
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw denied();
    const parts = path ? path.split("/") : [];
    for (const part of parts) {
      current = join(current, part);
      const info = await lstat(current).catch(() => {
        throw denied();
      });
      if (info.isSymbolicLink() || !info.isDirectory()) throw denied();
      const resolved = await realpath(current);
      const local = relative(this.root, resolved);
      if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw denied();
      current = resolved;
    }
    const info = await lstat(current).catch(() => {
      throw denied();
    });
    if (info.isSymbolicLink() || !info.isDirectory()) throw denied();
    return current;
  }

  private async readDirectory(path: string) {
    const target = await this.directoryTarget(path);
    await this.beforeOpen?.(path || ".");
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const directoryFlag = process.platform === "win32" ? 0 : constants.O_DIRECTORY;
    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_RDONLY | noFollow | directoryFlag);
    } catch {
      throw denied();
    }
    try {
      const opened = await handle.stat();
      const verifyIdentity = async () => {
        const checkedPath = await this.directoryTarget(path);
        const current = await stat(checkedPath);
        if (opened.dev !== current.dev || opened.ino !== current.ino) throw denied();
        return checkedPath;
      };
      const checkedPath = await verifyIdentity();
      const entries =
        process.platform === "linux"
          ? await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true })
          : await readdir(checkedPath, { withFileTypes: true });
      await verifyIdentity();
      return entries;
    } catch {
      throw denied();
    } finally {
      await handle.close();
    }
  }

  /**
   * Pin the opened file before trusting the path checks. The post-open identity
   * comparison rejects an ancestor that changed into a link while open() ran.
   */
  private async openChecked(
    path: string,
    flags: string,
    createParents = false,
  ): Promise<FileHandle> {
    const target = await this.target(path, createParents);
    await this.beforeOpen?.(path);
    let file: FileHandle;
    try {
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      const numericFlags =
        flags === "r"
          ? constants.O_RDONLY
          : flags === "r+"
            ? constants.O_RDWR
            : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
      file = await open(target, numericFlags | noFollow, flags === "wx" ? 0o666 : undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
      throw denied();
    }
    try {
      const opened = await file.stat();
      const checkedPath = await this.target(path);
      const current = await stat(checkedPath);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      )
        throw denied();
      return file;
    } catch {
      await file.close();
      throw denied();
    }
  }

  async read(path: string): Promise<string> {
    const file = await this.openChecked(path, "r");
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
    let file;
    try {
      file = await this.openChecked(path, "wx", true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw denied();
      file = await this.openChecked(path, "r+");
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
      for (const entry of await this.readDirectory(directory)) {
        if (result.length >= 1000) return;
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        try {
          this.parts(path);
        } catch {
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await this.directoryTarget(path);
          await visit(path, depth + 1);
        } else if (entry.isFile()) {
          const initial = await lstat(join(this.root, ...path.split("/")));
          if (!initial.isFile() || initial.nlink !== 1) continue;
          const target = await this.target(path);
          const resolved = await realpath(target);
          const local = relative(this.root, resolved);
          if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw denied();
          const info = await lstat(resolved);
          if (info.isFile() && info.nlink === 1) result.push(path);
        }
      }
    };
    await visit("", 0);
    return result.sort();
  }
}
