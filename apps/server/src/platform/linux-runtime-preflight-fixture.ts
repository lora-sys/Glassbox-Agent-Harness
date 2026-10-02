import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { linuxRuntimePreflight } from "../../../../scripts/linux-runtime-preflight.mjs";
export const linuxRuntimePreflightFixtureScript = new URL(import.meta.url);
async function runFixture() {
  assert.equal(process.platform, "linux");
  const [root] = process.argv.slice(2);
  assert.ok(root);
  const kit = join(root, "kit");
  const pi = join(root, "pi");
  await mkdir(kit);
  await mkdir(pi);
  await linuxRuntimePreflight({
    GLASSBOX_DATA_DIR: join(root, "data"),
    LORA_PI_KIT_PATH: kit,
    PI_CODING_AGENT_DIR: pi,
    PORT: "3030",
  });
  assert.deepEqual((await readdir(root)).sort(), ["kit", "pi"]);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
