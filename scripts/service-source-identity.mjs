import { execFileSync } from "node:child_process";

export function serviceSourceIdentity(checkout, capture = execFileSync) {
  try {
    const git = (args) =>
      capture("git", args, {
        cwd: checkout,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = git(["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40}$/.test(commit)) return undefined;
    return { launchCommit: commit, launchClean: git(["status", "--porcelain"]) === "" };
  } catch {
    return undefined;
  }
}
