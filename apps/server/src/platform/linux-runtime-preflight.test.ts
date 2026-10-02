import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureProcess } from "../persistence/test-fixture-process.js";
import { linuxRuntimePreflightFixtureScript } from "./linux-runtime-preflight-fixture.js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { linuxRuntimePreflight } from "../../../../scripts/linux-runtime-preflight.mjs";
import { getGlassboxDataDir, getServiceDataDir } from "./paths.js";
import {
  persistedEnvironment,
  serviceEnvironmentKeys,
} from "../../../../scripts/service-environment.mjs";
const io = vi.hoisted(() => ({ stat: vi.fn(), preflight: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  stat: io.stat,
}));
vi.mock("../workspace/registry.js", () => ({ WorkspaceRegistry: { preflight: io.preflight } }));
const env = {
  GLASSBOX_DATA_DIR: "/fixture/data",
  LORA_PI_KIT_PATH: "/fixture/kit",
  PI_CODING_AGENT_DIR: "/fixture/pi",
  PORT: "3030",
};
beforeEach(() => {
  vi.resetAllMocks();
  io.stat.mockImplementation(async (path: string) => {
    if (path === env.LORA_PI_KIT_PATH || path === env.PI_CODING_AGENT_DIR)
      return { isDirectory: () => true };
    throw Object.assign(new Error("missing fixture directory"), { code: "ENOENT" });
  });
  io.preflight.mockResolvedValue(undefined);
});
describe("Linux runtime environment preflight semantics on every test host", () => {
  it("accepts explicit new-install paths without creating data or requiring optional services", async () => {
    await linuxRuntimePreflight(env);
    expect(io.preflight).toHaveBeenCalledWith({
      dataRoot: env.GLASSBOX_DATA_DIR,
      forbiddenRoots: [env.LORA_PI_KIT_PATH],
    });
    const previous = process.env.GLASSBOX_DATA_DIR;
    try {
      process.env.GLASSBOX_DATA_DIR = env.GLASSBOX_DATA_DIR;
      expect(getGlassboxDataDir()).toBe(getServiceDataDir());
    } finally {
      if (previous === undefined) delete process.env.GLASSBOX_DATA_DIR;
      else process.env.GLASSBOX_DATA_DIR = previous;
    }
  });
  it.each(["GLASSBOX_DATA_DIR", "LORA_PI_KIT_PATH", "PI_CODING_AGENT_DIR", "PORT"])(
    "rejects missing %s",
    async (key) => {
      await expect(linuxRuntimePreflight({ ...env, [key]: undefined })).rejects.toThrow(key);
    },
  );
  it("rejects Windows and relative paths and unavailable required directories", async () => {
    for (const value of ["C:\\Users\\Owner\\.glassbox", "./data", "~/.glassbox"])
      await expect(linuxRuntimePreflight({ ...env, GLASSBOX_DATA_DIR: value })).rejects.toThrow(
        "explicit absolute Linux path",
      );
    await expect(
      linuxRuntimePreflight({ ...env, PI_CODING_AGENT_DIR: "/fixture/missing" }),
    ).rejects.toThrow("PI_CODING_AGENT_DIR directory is unavailable");
  });
  it("permits configured Temporal routing through the launcher without persisting credentials", () => {
    const configured = {
      GLASSBOX_TEMPORAL_ADDRESS: "127.0.0.1:7233",
      GLASSBOX_TEMPORAL_NAMESPACE: "default",
    };
    for (const key of Object.keys(configured)) expect(serviceEnvironmentKeys.has(key)).toBe(true);
    expect(persistedEnvironment({ ...configured, AGNES_API_KEY: "fixture" })).toEqual(configured);
  });
});

// Native filesystem integration is specific to Linux deployment. All semantic tests above
// run on every host, including rejection of Windows paths. No empty Windows-only test file.
if (process.platform === "linux") {
  it("validates real Linux deployment directories without creating missing data", async ({
    signal,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "glassbox-linux-env-"));
    try {
      await runFixtureProcess(linuxRuntimePreflightFixtureScript, [root], signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
