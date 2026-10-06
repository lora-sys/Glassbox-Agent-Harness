import { randomUUID } from "node:crypto";
import { open, link, rename, unlink, lstat } from "node:fs/promises";
import { dirname, resolve, parse, join } from "node:path";
import { LiveError } from "./core.mjs";

const PRIVATE_MODE = 0o600;

function checkpointError(operation, cause, published = false) {
  const error = new LiveError(
    "MEMORY_CHECKPOINT_IO",
    `Memory checkpoint IO failed during ${operation}.`,
    "INCONCLUSIVE",
  );
  error.operation = operation;
  error.published = published;
  if (cause instanceof Error) error.cause = cause;
  return error;
}

function ancestorDirectories(paths) {
  const result = new Set();
  for (const path of paths) {
    let current = resolve(dirname(path));
    const root = parse(current).root;
    while (current) {
      result.add(current);
      if (current === root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...result];
}

async function syncDirectories(paths, io) {
  for (const directory of ancestorDirectories(paths)) {
    if (io.syncDirectory) {
      await io.syncDirectory(directory);
      continue;
    }
    const handle = await io.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function withOperation(operation, published, callback) {
  try {
    return await callback();
  } catch (error) {
    throw checkpointError(operation, error, published);
  }
}

async function closeAfter(handle, callback, operation, published) {
  try {
    await callback(handle);
  } catch (error) {
    throw checkpointError(operation, error, published);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      throw checkpointError(`${operation}_close`, error, published);
    }
  }
}

function samePath(a, b) {
  return resolve(a) === resolve(b);
}

/**
 * Persist one Memory lifecycle checkpoint. Production callers must use the default
 * filesystem adapter so file and directory fsync operations cannot be bypassed.
 * `io` is injectable for deterministic filesystem fault tests.
 */
export async function writeMemoryCheckpoint({ pendingPath, journalPath, row, first, io = {} }) {
  if (
    typeof pendingPath !== "string" ||
    !pendingPath ||
    typeof journalPath !== "string" ||
    !journalPath ||
    samePath(pendingPath, journalPath) ||
    typeof first !== "boolean"
  )
    throw new TypeError("Invalid Memory checkpoint paths or first-write flag");
  const pending = resolve(pendingPath);
  const journal = resolve(journalPath);
  const fs = { open, link, rename, unlink, lstat, ...io };
  const nonce = randomUUID();
  const temporary = join(dirname(pending), `.memory-checkpoint-${nonce}.tmp`);
  const serialized = JSON.stringify(row);
  if (typeof serialized !== "string") throw new TypeError("Checkpoint row must serialize as JSON");
  const journalLine = `${serialized}\n`;
  let temporaryCreated = false;
  let published = false;
  let primaryError;

  try {
    const tempHandle = await withOperation("temporary_create", false, () =>
      fs.open(temporary, "wx", PRIVATE_MODE),
    );
    temporaryCreated = true;
    await closeAfter(
      tempHandle,
      async (handle) => {
        await handle.chmod(PRIVATE_MODE);
        await handle.writeFile(journalLine, { encoding: "utf8" });
        await handle.sync();
      },
      "temporary_write_fsync",
      false,
    );

    const journalHandle = await withOperation("journal_open", false, () =>
      fs.open(journal, "a", PRIVATE_MODE),
    );
    await closeAfter(
      journalHandle,
      async (handle) => {
        await handle.chmod(PRIVATE_MODE);
        await handle.writeFile(journalLine, { encoding: "utf8" });
        await handle.sync();
      },
      "journal_append_fsync",
      false,
    );
    await withOperation("journal_directory_fsync", false, () => syncDirectories([journal], fs));

    if (first) {
      await withOperation("first_publish_link", false, () => fs.link(temporary, pending));
      published = true;
      await withOperation("first_publish_directory_fsync", true, () =>
        syncDirectories([pending], fs),
      );
    } else {
      const existing = await withOperation("pending_check", false, () => fs.lstat(pending));
      if (!existing.isFile() || existing.isSymbolicLink())
        throw checkpointError("pending_check", new Error("pending guard is not a regular file"));
      await withOperation("pending_directory_fsync_before_replace", false, () =>
        syncDirectories([pending], fs),
      );
      const backup = join(dirname(pending), `.memory-checkpoint-${nonce}.old`);
      let backupCreated = false;
      try {
        await withOperation("pending_backup_link", false, () => fs.link(pending, backup));
        backupCreated = true;
        await withOperation("pending_backup_directory_fsync", false, () =>
          syncDirectories([pending], fs),
        );
        await withOperation("pending_replace_rename", false, () => fs.rename(temporary, pending));
        temporaryCreated = false;
        published = true;
        try {
          await withOperation("pending_replace_directory_fsync", true, () =>
            syncDirectories([pending], fs),
          );
        } catch (error) {
          try {
            await withOperation("pending_replace_rollback", true, () => fs.rename(backup, pending));
            backupCreated = false;
            published = false;
            if (error instanceof Error) error.published = false;
            await withOperation("pending_rollback_directory_fsync", false, () =>
              syncDirectories([pending], fs),
            );
          } catch (rollbackError) {
            if (rollbackError instanceof Error) rollbackError.recoveryPath = backup;
            throw rollbackError;
          }
          throw error;
        }
        await withOperation("pending_backup_remove", true, () => fs.unlink(backup));
        backupCreated = false;
        await withOperation("pending_backup_remove_directory_fsync", true, () =>
          syncDirectories([pending], fs),
        );
      } catch (error) {
        if (backupCreated && !published) {
          try {
            await fs.unlink(backup);
            await syncDirectories([pending], fs);
          } catch (cleanupError) {
            if (error instanceof Error) error.recoveryPath = backup;
            if (cleanupError instanceof Error && error instanceof Error)
              error.cleanupCause = cleanupError;
          }
        }
        throw error;
      }
    }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error("checkpoint failure");
  } finally {
    if (temporaryCreated) {
      try {
        await fs.unlink(temporary);
        await syncDirectories([pending], fs);
      } catch (error) {
        if (!primaryError) primaryError = checkpointError("temporary_cleanup", error, published);
      }
    }
  }

  if (primaryError) throw primaryError;
  return { published: true };
}
