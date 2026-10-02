import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceRegistry } from "../apps/server/src/workspace/registry.js";

/** Deployment-only validation. Historical direct-server and service defaults stay unchanged. */
export async function linuxRuntimePreflight(env: NodeJS.ProcessEnv): Promise<void> {
  for (const key of ["GLASSBOX_DATA_DIR", "LORA_PI_KIT_PATH", "PI_CODING_AGENT_DIR"] as const) {
    const value = env[key];
    if (
      !value ||
      value.trim() !== value ||
      !isAbsolute(value) ||
      /^[A-Za-z]:|\\|^\/\//u.test(value) ||
      value.includes("\0")
    )
      throw new Error(`${key} must be an explicit absolute Linux path in runtime.env`);
    try {
      if (!(await stat(value)).isDirectory()) throw new Error(`${key} must name a directory`);
    } catch (error) {
      if (key === "GLASSBOX_DATA_DIR" && (error as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      throw new Error(`${key} directory is unavailable; check the deployment configuration`);
    }
  }
  if (!env.PORT || !/^\d{1,5}$/u.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535)
    throw new Error("PORT must be explicit and between 1 and 65535 in runtime.env");
  await WorkspaceRegistry.preflight({
    dataRoot: env.GLASSBOX_DATA_DIR!,
    forbiddenRoots: [env.LORA_PI_KIT_PATH!],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await linuxRuntimePreflight(process.env);
  process.stdout.write(
    "Linux runtime paths and workspace registry passed read-only preflight. External services and credentials were not tested.\n",
  );
}
