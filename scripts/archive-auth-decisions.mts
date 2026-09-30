import { open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  archiveDecisionBatch,
  readArchivedDecisionPage,
} from "../apps/server/src/persistence/decision-archive.js";
import { DomainDatabase, stringColumn } from "../apps/server/src/persistence/database.js";

const args = process.argv.slice(2);
if (
  args.length !== 6 ||
  args[0] !== "--database" ||
  args[2] !== "--before" ||
  args[4] !== "--output"
) {
  throw new Error(
    "Usage: tsx scripts/archive-auth-decisions.mts --database PATH --before ISO_TIMESTAMP --output JSONL_PATH",
  );
}
const [, databasePath, , before, , outputPath] = args;
if (!databasePath || !before || !outputPath || !Number.isFinite(Date.parse(before)))
  throw new Error("Database, ISO cutoff, and output path are required");
if (resolve(databasePath) === resolve(outputPath))
  throw new Error("Output must differ from database");

const db = await DomainDatabase.open(databasePath);
const temporary = `${outputPath}.tmp-${process.pid}`;
let exported = 0;
let archived = 0;
try {
  let count: number;
  do {
    count = await archiveDecisionBatch(db, before);
    archived += count;
  } while (count === 500);
  const file = await open(temporary, "wx");
  try {
    let cursor: { createdAt: string; id: string } | null = null;
    while (true) {
      const rows = await readArchivedDecisionPage(db, before, cursor);
      if (!rows.length) break;
      for (const row of rows) {
        await file.write(`${JSON.stringify(row)}\n`);
        exported += 1;
      }
      const last = rows.at(-1)!;
      cursor = { createdAt: stringColumn(last, "created_at"), id: stringColumn(last, "id") };
    }
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, outputPath);
  process.stdout.write(
    `Archived ${archived} decisions; exported ${exported} archive records to ${outputPath}\n`,
  );
} finally {
  await rm(temporary, { force: true });
  await db.close();
}
