import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

it("loads guarded Worker tools through Pi's public extension loader with no built-in tools active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-extension-"));
  const models = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [
      fileURLToPath(new URL("./worker-tools-extension.ts", import.meta.url)),
    ],
  });
  let session;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const names = ["worker_read_file", "worker_write_file", "worker_list_files"];
    const created = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      modelRuntime: models,
      noTools: "all",
      tools: names,
    });
    session = created.session;
    expect(session.getActiveToolNames().sort()).toEqual(names.sort());
    await session.bindExtensions({});
    const projected = await session.extensionRunner!.emitBeforeAgentStart(
      "hello",
      undefined,
      `Current working directory: ${directory}`,
      { cwd: directory },
    );
    expect(projected?.systemPrompt).toBe(
      "Worker configuration is unavailable. No tools are authorized.",
    );
  } finally {
    session?.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
