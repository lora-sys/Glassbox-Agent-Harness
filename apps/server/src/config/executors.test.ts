import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ExecutorConfiguration, localClaudeConnection } from "./executors.js";
import { ModelProfileStore } from "./model-profiles.js";

const harness = vi.hoisted(() => ({
  hash: "a".repeat(64),
  execute: vi.fn(),
  path: "installed-fixture" as string | undefined,
}));
vi.mock("../platform/executable.js", () => ({ resolveClaudeExecutable: () => harness.path }));
vi.mock("../execution/harness/index.js", () => ({
  executableSha256: async () => harness.hash,
  createClaudeHarnessAdapter: () => ({ execute: harness.execute }),
}));
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-executor-config-"));
  directories.push(directory);
  const models = await ModelProfileStore.open(directory);
  const options = { dataDirectory: directory, models, localConfigDirectory: directory };
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "fixture-credential",
        ANTHROPIC_BASE_URL: "https://fixture.invalid",
        ANTHROPIC_MODEL: "fixture-model",
      },
      hooks: { private: "DO NOT APPLY" },
      permissions: { allow: ["Bash(*)"] },
    }),
  );
  return { directory, models, options, config: await ExecutorConfiguration.open(options) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  harness.path = "installed-fixture";
  harness.hash = "a".repeat(64);
  harness.execute.mockReset();
});
describe("shared executor configuration", () => {
  it("bridges only explicit Claude connection fields without applying private settings", async () => {
    const { directory, config } = await fixture();
    expect(await localClaudeConnection(directory)).toEqual({
      credentials: { ANTHROPIC_AUTH_TOKEN: "fixture-credential" },
      apiBaseUrl: "https://fixture.invalid",
      model: "fixture-model",
    });
    expect(JSON.stringify(await config.list())).not.toContain("fixture-credential");
    expect(harness.execute).not.toHaveBeenCalled();
  });
  it("saves the profile reference, reopens and rejects arbitrary credential injection", async () => {
    const { models, config, options, directory } = await fixture();
    await models.save({
      id: "anthropic",
      label: "Fixture",
      protocol: "anthropic-messages",
      baseUrl: "https://fixture.invalid",
      model: "fixture",
      apiKey: "profile-credential",
    });
    await config.save({
      id: "claude-code",
      credentialSource: "model-profile",
      modelProfileId: "anthropic",
      model: null,
    });
    expect((await (await ExecutorConfiguration.open(options)).list())[0]).toMatchObject({
      modelProfileId: "anthropic",
      groupSupported: false,
    });
    expect(await readFile(join(directory, "executors.json"), "utf8")).not.toContain(
      "profile-credential",
    );
    expect(() =>
      config.save({ id: "claude-code", credentialSource: "local-claude", apiKey: "injected" }),
    ).toThrow();
  });
  it("deduplicates in-flight checks and invalidates proof when the installed file changes", async () => {
    const { config } = await fixture();
    let release!: (result: unknown) => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    harness.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
          started();
        }),
    );
    const first = config.check();
    await pending;
    expect((await config.list())[0]?.checking).toBe(true);
    await expect(config.check()).rejects.toThrow("already running");
    await expect(
      config.save({ id: "claude-code", credentialSource: "local-claude" }),
    ).rejects.toThrow("already running");
    release({ status: "succeeded", text: "GLASSBOX_EXECUTOR_OK" });
    expect(await first).toMatchObject({
      checking: false,
      groupSupported: true,
      lastCheck: { status: "passed" },
    });
    expect(harness.execute).toHaveBeenCalledTimes(1);
    harness.hash = "b".repeat(64);
    expect((await config.list())[0]).toMatchObject({
      groupSupported: false,
      lastCheck: { code: "EXECUTABLE_CHANGED" },
    });
  });
  it("does not attest a binary replaced during its actual check", async () => {
    const { config } = await fixture();
    harness.execute.mockImplementation(async () => {
      harness.hash = "b".repeat(64);
      return { status: "succeeded", text: "GLASSBOX_EXECUTOR_OK" };
    });
    expect(await config.check()).toMatchObject({
      groupSupported: false,
      lastCheck: { status: "failed" },
    });
  });
  it("rejects expired OAuth and OAuth with a custom endpoint", async () => {
    const { directory } = await fixture();
    await writeFile(join(directory, "settings.json"), "{}");
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "fixture-expired", expiresAt: Date.now() - 1 },
      }),
    );
    await expect(localClaudeConnection(directory)).rejects.toThrow("expired");
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other.invalid" } }),
    );
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "fixture-live", expiresAt: Date.now() + 60000 },
      }),
    );
    await expect(localClaudeConnection(directory)).rejects.toThrow("custom endpoint");
  });
});
