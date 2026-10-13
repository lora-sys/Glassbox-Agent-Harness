import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Publish the entire report only after its bytes reach storage. */
export async function writeDurableReport(path, value, io = { open, rename, rm }) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await io.open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
    await file.close();
    file = undefined;
    await io.rename(temporary, path);
    const directory = await io.open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file?.close();
    await io.rm(temporary, { force: true });
  }
}
