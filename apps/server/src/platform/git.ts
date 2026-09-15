// apps/server/src/platform/git.ts
// Workspace git-diff scanning helpers with safe argv execution (no shell interpolation, ESM-clean).

import { execFileSync } from "node:child_process";

export interface FileSnapshot {
  [filePath: string]: string;
}

export interface FileChange {
  path: string;
  kind: "add" | "delete" | "rename" | "modify";
  diff?: string;
}

/**
 * Capture git index file hashes for the current workspace.
 */
export function gitLsFiles(cwd: string): FileSnapshot | null {
  try {
    const out = execFileSync("git", ["ls-files", "-s"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim();

    if (!out) return null;
    const snap: FileSnapshot = {};
    for (const line of out.split("\n")) {
      // Format: <mode> <sha1> <stage>\t<path>
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const sha = line.slice(4, 45);
      const filePath = line.slice(tab + 1);
      snap[filePath] = sha;
    }
    return snap;
  } catch {
    return null;
  }
}

/**
 * Scan git workspace changes compared to previous snapshot.
 * Uses safe argv array passing to avoid shell injection.
 */
export function gitDiffForScan(cwd: string, snapshot: FileSnapshot): FileChange[] {
  try {
    const changes: FileChange[] = [];

    // name-status: list changed files with short status codes
    const statOut = execFileSync("git", ["diff", "--name-status"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim();

    if (statOut) {
      for (const line of statOut.split("\n")) {
        const parts = line.split("\t");
        const status = parts[0] ?? "M";
        const filePath = parts[1] ?? "";
        if (!filePath) continue;

        const kind: FileChange["kind"] =
          status === "A" ? "add" : status === "D" ? "delete" : status === "R" ? "rename" : "modify";

        try {
          const diffOut = execFileSync("git", ["diff", "--", filePath], {
            cwd,
            encoding: "utf-8",
            timeout: 5000,
            windowsHide: true,
          }).trim();
          changes.push({ path: filePath, kind, diff: diffOut.slice(0, 2048) });
        } catch {
          changes.push({ path: filePath, kind });
        }
      }
    } else {
      // Fallback: compare against stored snapshot
      const current = gitLsFiles(cwd);
      if (current) {
        for (const [p, oldSha] of Object.entries(snapshot)) {
          if (oldSha !== current[p]) {
            changes.push({ path: p, kind: "modify" });
          }
        }
        for (const p of Object.keys(current)) {
          if (!(p in snapshot)) {
            changes.push({ path: p, kind: "add" });
          }
        }
      }
    }
    return changes;
  } catch {
    return [];
  }
}
