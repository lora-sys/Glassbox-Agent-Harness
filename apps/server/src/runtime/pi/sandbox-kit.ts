import { pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PINNED_PI_VERSION } from "./kit-loader.js";
import type { IsolatedPiSession } from "./sandbox-pi-tools.js";

export interface KitSandboxExecutor {
  doctor(): Promise<{
    ready: true;
    provider: "docker";
    image: string;
    availableTools: string[];
    cliAvailable: boolean;
  }>;
  openSession(input: {
    sessionId: string;
    workspacePath: string;
    writable: boolean;
    policyVersion: string;
    network: "none";
  }): Promise<IsolatedPiSession>;
  close(): Promise<void>;
}

async function verifySandboxLock(kitPath: string, image: string): Promise<void> {
  const lock = JSON.parse(
    await readFile(path.join(kitPath, "locks", "sandbox-image.json"), "utf8"),
  ) as {
    schemaVersion?: unknown;
    image?: unknown;
    pi?: unknown;
    sha256?: Record<string, unknown>;
  };
  if (lock.schemaVersion !== 1 || lock.image !== image || lock.pi !== PINNED_PI_VERSION)
    throw new Error("Kit sandbox release lock does not match the configured image and Pi version");
  const required = [
    "dist/src/sandbox/index.js",
    "dist/src/sandbox/worker.js",
    "dist/src/sandbox/protocol.js",
    "dist/src/sandbox/container-stop.js",
  ];
  for (const relative of required) {
    const expected = lock.sha256?.[relative];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected))
      throw new Error(`Kit sandbox release lock is missing ${relative}`);
    const actual = createHash("sha256")
      .update(await readFile(path.join(kitPath, relative)))
      .digest("hex");
    if (actual !== expected) throw new Error(`Kit sandbox release content differs for ${relative}`);
  }
}

/** Only trusted deployment configuration chooses the immutable container image. */
export async function loadKitSandbox(kitPath: string): Promise<{
  executor: KitSandboxExecutor;
  availableTools: ReadonlySet<string>;
  image: string;
} | null> {
  const image = process.env.GLASSBOX_SANDBOX_IMAGE;
  if (!image) return null;
  if (!/^(?:[a-z0-9][a-z0-9._/-]*@)?sha256:[a-f0-9]{64}$/u.test(image))
    throw new Error("GLASSBOX_SANDBOX_IMAGE must pin a sha256 digest");
  await verifySandboxLock(kitPath, image);
  const kitModulePath = path.join(kitPath, "dist", "src", "sandbox", "index.js");
  const module = (await import(pathToFileURL(kitModulePath).href)) as {
    createDockerSandboxExecutor?: (input: { image: string }) => KitSandboxExecutor;
  };
  if (typeof module.createDockerSandboxExecutor !== "function")
    throw new Error("Pinned Kit has no sandbox executor");
  const executor = module.createDockerSandboxExecutor({ image });
  try {
    const probe = await executor.doctor();
    if (probe.ready !== true || probe.provider !== "docker")
      throw new Error("Sandbox probe did not establish Docker isolation");
    return { executor, availableTools: new Set(probe.availableTools), image: probe.image };
  } catch (error) {
    await executor.close();
    throw error;
  }
}
