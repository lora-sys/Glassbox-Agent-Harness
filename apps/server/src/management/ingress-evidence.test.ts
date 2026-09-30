import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vite-plus/test";
import { IngressEvidenceLog } from "./ingress-evidence.js";

const execFile = promisify(execFileCallback);

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});

const dataDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "glassbox-ingress-evidence-"));
  tempDirs.push(dir);
  return dir;
};

it("counts from nothing when no group message was ever observed", async () => {
  const log = IngressEvidenceLog.open(await dataDir());
  expect(log.countsFor("qq", "group-1", "2026-01-01T00:00:00.000Z")).toEqual({
    serviceStartedAt: "2026-01-01T00:00:00.000Z",
    lastObservedAt: null,
    normalized: 0,
    ignoredNotAddressed: 0,
    ignoredEmptyMessage: 0,
    droppedNotReady: 0,
    rejectedInvalidMessage: 0,
    rejectedUnsupportedMessage: 0,
    rejectedOverflow: 0,
    acceptanceFailed: 0,
  });
});

it("keeps ingress evidence across a restart, which is when it is needed most", async () => {
  const dir = await dataDir();
  const before = IngressEvidenceLog.open(dir);
  before.recordNormalized("qq", "group-1", "2026-09-01T10:00:00.000Z");
  before.recordDropped("qq", "group-1", "not_addressed", "2026-09-01T10:00:01.000Z");
  before.recordDropped("qq", "group-1", "empty_message", "2026-09-01T10:00:02.000Z");
  before.recordDropped("qq", "group-2", "invalid_message", "2026-09-01T10:00:03.000Z");
  // A group that went silent because the socket was not ready is not a group that went silent
  // because it was not addressed; the two must stay in separate counters across the restart too.
  before.recordDropped("qq", "group-1", "not_ready", "2026-09-01T10:00:04.000Z");

  // A new process over the same data directory must see what the previous one saw.
  const after = IngressEvidenceLog.open(dir);

  expect(after.countsFor("qq", "group-1", "should-not-be-used")).toEqual({
    serviceStartedAt: "2026-09-01T10:00:00.000Z",
    lastObservedAt: "2026-09-01T10:00:04.000Z",
    normalized: 1,
    ignoredNotAddressed: 1,
    ignoredEmptyMessage: 1,
    droppedNotReady: 1,
    rejectedInvalidMessage: 0,
    rejectedUnsupportedMessage: 0,
    rejectedOverflow: 0,
    acceptanceFailed: 0,
  });
  // Other groups keep their own counters rather than sharing one bucket.
  expect(after.countsFor("qq", "group-2", "should-not-be-used")).toMatchObject({
    normalized: 0,
    rejectedInvalidMessage: 1,
    serviceStartedAt: "2026-09-01T10:00:03.000Z",
  });
  // A group with no evidence at all still falls back to the process start.
  expect(after.countsFor("qq", "group-3", "2026-09-02T00:00:00.000Z")).toMatchObject({
    serviceStartedAt: "2026-09-02T00:00:00.000Z",
    normalized: 0,
    lastObservedAt: null,
  });
});

it("writes no message content into the evidence log", async () => {
  const dir = await dataDir();
  const log = IngressEvidenceLog.open(dir);
  log.recordDropped("qq", "group-1", "not_addressed", "2026-09-01T10:00:00.000Z");
  log.recordNormalized("qq", "group-1", "2026-09-01T10:00:01.000Z");

  const contents = await readFile(join(dir, "ingress-diagnostics.jsonl"), "utf-8");
  const lines = contents.trim().split("\n");
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["channelId", "groupId", "reason", "ts"]);
  }
});

it("reads the evidence it can and skips a line it cannot", async () => {
  const dir = await dataDir();
  const logPath = join(dir, "ingress-diagnostics.jsonl");
  await writeFile(
    logPath,
    `${JSON.stringify({
      ts: "2026-09-01T10:00:00.000Z",
      channelId: "qq",
      groupId: "group-1",
      reason: "not_addressed",
    })}\nnot json at all\n${JSON.stringify({
      ts: "2026-09-01T10:00:01.000Z",
      channelId: "qq",
      groupId: "group-1",
      reason: "acceptance_failed",
    })}\n`,
    "utf-8",
  );

  const log = IngressEvidenceLog.open(dir);
  expect(log.countsFor("qq", "group-1", "unused")).toMatchObject({
    ignoredNotAddressed: 1,
    acceptanceFailed: 1,
  });
});

/** Asserts the file grants exactly one user full control, with no inherited rules leaking in. */
async function expectRestrictedToOwner(path: string): Promise<void> {
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    return;
  }
  const { stdout } = await execFile("icacls.exe", [path], { windowsHide: true });
  const entries = stdout.split(/\r?\n/u).filter((line) => /:\([^)]*\)/u.test(line));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toContain("(F)");
  expect(entries[0]).not.toContain("(I)");
}

it("writes its evidence file restricted to the owner", async () => {
  const dir = await dataDir();
  const logPath = join(dir, "ingress-diagnostics.jsonl");
  // A log left loose by an earlier process must not stay that way: it names groups and channel ids.
  await writeFile(logPath, "x", { mode: 0o644 });

  const log = IngressEvidenceLog.open(dir);
  log.recordNormalized("qq", "group-1", "2026-09-01T10:00:00.000Z");
  await log.secureFile();

  await expectRestrictedToOwner(logPath);
});

it("does not create a log just to secure one", async () => {
  const dir = await dataDir();
  const log = IngressEvidenceLog.open(dir);
  await log.secureFile();
  await expect(stat(join(dir, "ingress-diagnostics.jsonl"))).rejects.toThrow();
});
