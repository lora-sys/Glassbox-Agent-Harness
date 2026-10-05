import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  open,
  link,
  rename,
  unlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryCheckpoint } from "../lib/memory-checkpoint.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qq-memory-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pendingPath = join(root, "locks", "driver.memory-pending.json");
  const journalPath = join(root, "reports", "run", "memory-fixture.jsonl");
  await Promise.all([
    mkdir(join(root, "locks")),
    mkdir(join(root, "reports", "run"), { recursive: true }),
  ]);
  const syncs = [];
  const chmodCalls = [];
  const io = {
    open: async (path, ...args) => {
      const handle = await open(path, ...args);
      return {
        chmod: async (mode) => {
          chmodCalls.push({ path, mode });
          return handle.chmod(mode);
        },
        writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    link,
    rename,
    unlink,
    lstat,
    syncDirectory: async (path) => {
      syncs.push(path);
    },
  };
  return { root, pendingPath, journalPath, io, syncs, chmodCalls };
}

const oldRow = { schemaVersion: 1, phase: "prepared", marker: "a".repeat(32) };
const nextRow = { schemaVersion: 1, phase: "observed", candidateId: "candidate_fixture" };
const jsonLine = (row) => `${JSON.stringify(row)}\n`;

test("first publish writes private complete files and leaves no temporary files", async (t) => {
  const f = await fixture(t);
  await writeMemoryCheckpoint({
    pendingPath: f.pendingPath,
    journalPath: f.journalPath,
    row: oldRow,
    first: true,
    io: f.io,
  });

  assert.equal(await readFile(f.pendingPath, "utf8"), jsonLine(oldRow));
  assert.equal(await readFile(f.journalPath, "utf8"), jsonLine(oldRow));
  assert.ok(f.chmodCalls.some((entry) => entry.path.includes(".tmp") && entry.mode === 0o600));
  assert.ok(f.chmodCalls.some((entry) => entry.path === f.journalPath && entry.mode === 0o600));
  if (process.platform !== "win32") assert.equal((await stat(f.pendingPath)).mode & 0o077, 0);
  assert.ok(f.syncs.includes(join(f.root, "locks")));
  assert.ok(f.syncs.includes(join(f.root, "reports", "run")));
  assert.deepEqual((await readdir(join(f.root, "locks"))).sort(), ["driver.memory-pending.json"]);
});

test("first publish uses an atomic no-overwrite hard link on EEXIST", async (t) => {
  const f = await fixture(t);
  await writeFile(f.pendingPath, jsonLine(oldRow), { mode: 0o600 });
  await assert.rejects(
    writeMemoryCheckpoint({
      pendingPath: f.pendingPath,
      journalPath: f.journalPath,
      row: nextRow,
      first: true,
      io: f.io,
    }),
    (error) => error.code === "MEMORY_CHECKPOINT_IO" && error.operation === "first_publish_link",
  );
  assert.equal(await readFile(f.pendingPath, "utf8"), jsonLine(oldRow));
  assert.deepEqual((await readdir(join(f.root, "locks"))).sort(), ["driver.memory-pending.json"]);
});

test("journal append failure leaves the old complete guard unchanged", async (t) => {
  const f = await fixture(t);
  await writeMemoryCheckpoint({
    pendingPath: f.pendingPath,
    journalPath: f.journalPath,
    row: oldRow,
    first: true,
    io: f.io,
  });
  const failingIO = {
    ...f.io,
    open: async (path, ...args) => {
      if (path === f.journalPath) throw new Error("injected journal failure");
      return open(path, ...args);
    },
  };
  await assert.rejects(
    writeMemoryCheckpoint({
      pendingPath: f.pendingPath,
      journalPath: f.journalPath,
      row: nextRow,
      first: false,
      io: failingIO,
    }),
    (error) => error.operation === "journal_open" && error.published === false,
  );
  assert.equal(await readFile(f.pendingPath, "utf8"), jsonLine(oldRow));
  assert.equal(await readFile(f.journalPath, "utf8"), jsonLine(oldRow));
  assert.deepEqual((await readdir(join(f.root, "locks"))).sort(), ["driver.memory-pending.json"]);
});

test("journal fsync failure is traceable and cannot publish the next guard", async (t) => {
  const f = await fixture(t);
  await writeMemoryCheckpoint({
    pendingPath: f.pendingPath,
    journalPath: f.journalPath,
    row: oldRow,
    first: true,
    io: f.io,
  });
  const failingIO = {
    ...f.io,
    open: async (path, ...args) => {
      const handle = await open(path, ...args);
      if (path !== f.journalPath) return handle;
      return {
        chmod: (mode) => handle.chmod(mode),
        writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
        sync: async () => {
          throw new Error("injected journal fsync failure");
        },
        close: () => handle.close(),
      };
    },
  };
  await assert.rejects(
    writeMemoryCheckpoint({
      pendingPath: f.pendingPath,
      journalPath: f.journalPath,
      row: nextRow,
      first: false,
      io: failingIO,
    }),
    (error) => error.operation === "journal_append_fsync" && error.published === false,
  );
  assert.equal(await readFile(f.pendingPath, "utf8"), jsonLine(oldRow));
  assert.deepEqual((await readdir(join(f.root, "locks"))).sort(), ["driver.memory-pending.json"]);
});

test("replacement requires the old pending guard and never silently creates it", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    writeMemoryCheckpoint({
      pendingPath: f.pendingPath,
      journalPath: f.journalPath,
      row: nextRow,
      first: false,
      io: f.io,
    }),
    (error) => error.operation === "pending_check" && error.published === false,
  );
  assert.deepEqual((await readdir(join(f.root, "locks"))).sort(), []);
});

test("rename failure leaves the old guard and reports the failed operation", async (t) => {
  const f = await fixture(t);
  await writeMemoryCheckpoint({
    pendingPath: f.pendingPath,
    journalPath: f.journalPath,
    row: oldRow,
    first: true,
    io: f.io,
  });
  const failingIO = {
    ...f.io,
    rename: async (from, to) => {
      if (from.endsWith(".tmp") && to === f.pendingPath) throw new Error("injected rename failure");
      return rename(from, to);
    },
  };
  await assert.rejects(
    writeMemoryCheckpoint({
      pendingPath: f.pendingPath,
      journalPath: f.journalPath,
      row: nextRow,
      first: false,
      io: failingIO,
    }),
    (error) => error.operation === "pending_replace_rename" && error.published === false,
  );
  assert.equal(await readFile(f.pendingPath, "utf8"), jsonLine(oldRow));
  assert.deepEqual((await readdir(join(f.root, "locks"))).sort(), ["driver.memory-pending.json"]);
});

test("post-rename directory fsync failure rolls back and remains an error", async (t) => {
  const f = await fixture(t);
  await writeMemoryCheckpoint({
    pendingPath: f.pendingPath,
    journalPath: f.journalPath,
    row: oldRow,
    first: true,
    io: f.io,
  });
  let replacementOccurred = false;
  let injected = false;
  const failingIO = {
    ...f.io,
    rename: async (from, to) => {
      if (from.endsWith(".tmp") && to === f.pendingPath) replacementOccurred = true;
      if (from.endsWith(".old") && to === f.pendingPath) replacementOccurred = false;
      return rename(from, to);
    },
    syncDirectory: async (path) => {
      if (replacementOccurred && !injected) {
        injected = true;
        throw new Error("injected directory fsync failure");
      }
      f.syncs.push(path);
    },
  };
  await assert.rejects(
    writeMemoryCheckpoint({
      pendingPath: f.pendingPath,
      journalPath: f.journalPath,
      row: nextRow,
      first: false,
      io: failingIO,
    }),
    (error) => error.operation === "pending_replace_directory_fsync" && error.published === false,
  );
  assert.equal(await readFile(f.pendingPath, "utf8"), jsonLine(oldRow));
  assert.deepEqual((await readdir(join(f.root, "locks"))).sort(), ["driver.memory-pending.json"]);
});

test("successful replacement appends and atomically publishes without temp or backup leaks", async (t) => {
  const f = await fixture(t);
  await writeMemoryCheckpoint({
    pendingPath: f.pendingPath,
    journalPath: f.journalPath,
    row: oldRow,
    first: true,
    io: f.io,
  });
  await writeMemoryCheckpoint({
    pendingPath: f.pendingPath,
    journalPath: f.journalPath,
    row: nextRow,
    first: false,
    io: f.io,
  });

  assert.equal(await readFile(f.pendingPath, "utf8"), jsonLine(nextRow));
  assert.equal(await readFile(f.journalPath, "utf8"), jsonLine(oldRow) + jsonLine(nextRow));
  assert.deepEqual((await readdir(join(f.root, "locks"))).sort(), ["driver.memory-pending.json"]);
});
