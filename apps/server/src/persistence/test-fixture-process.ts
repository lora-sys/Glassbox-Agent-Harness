import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Test-only process isolation for native resources released on child exit. */
export async function runFixtureProcess(script: URL, args: string[], signal: AbortSignal) {
  const loader = createRequire(import.meta.url).resolve("tsx");
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(loader).href, fileURLToPath(script), ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal,
    },
  );
  let stdout = "";
  let stderr = "";
  let failure: Error | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    failure = error;
  });
  await new Promise<void>((resolve, reject) => {
    // An abort error alone does not prove exit. Wait for close on every path,
    // including cancellation, before the caller removes the child's files.
    child.once("close", (code, exitSignal) => {
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`Fixture process failed (${code ?? exitSignal}):\n${stdout}${stderr}`));
      else resolve();
    });
  });
  return stdout;
}
