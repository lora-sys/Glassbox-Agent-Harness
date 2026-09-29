import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { ModelProfileStore } from "../../config/model-profiles.js";
import { configuredPiModel } from "./configured-model.js";
import { PiModelCatalog } from "./model-catalog.js";

it("uses the selected Glassbox profile and resolves changes for each Pi Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-pi-profile-"));
  try {
    const profiles = await ModelProfileStore.open(directory);
    const config = {
      id: "local",
      label: "Local test",
      protocol: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "first",
      apiKey: "test-secret",
      supportsVision: true,
      contextWindowTokens: 8192,
      maxOutputTokens: 1024,
    };
    await profiles.save(config);
    const first = await configuredPiModel(profiles, "local");
    expect(first.model).toMatchObject({
      id: "first",
      api: "openai-completions",
      baseUrl: config.baseUrl,
      input: ["text", "image"],
    });
    expect(JSON.stringify(first.model)).not.toContain("test-secret");
    await profiles.save({ ...config, model: "second", protocol: "anthropic-messages" });
    const second = await configuredPiModel(profiles, "local");
    expect(second.model).toMatchObject({ id: "second", api: "anthropic-messages" });
    expect(second.modelRuntime).not.toBe(first.modelRuntime);
    await expect(configuredPiModel(profiles, "missing")).rejects.toThrow("not found");
    await profiles.save({ ...config, id: "unknown-capacity", contextWindowTokens: undefined });
    await expect(configuredPiModel(profiles, "unknown-capacity")).rejects.toThrow(
      "capacity is unknown",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses matching Pi credentials and capacity for a legacy Glassbox model profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-pi-profile-match-"));
  try {
    const piDirectory = join(directory, "pi-agent");
    await mkdir(piDirectory);
    const piSecret = "pi-provider-fixture-secret";
    await writeFile(
      join(piDirectory, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            name: "Fixture Provider",
            api: "anthropic-messages",
            baseUrl: "https://fixture.invalid/anthropic/",
            apiKey: piSecret,
            models: [
              {
                id: "shared-model",
                name: "Pi Shared Model",
                contextWindow: 131_072,
                maxTokens: 24_576,
                input: ["text"],
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const profiles = await ModelProfileStore.open(directory);
    await profiles.save({
      id: "legacy",
      label: "Legacy Glassbox Profile",
      protocol: "anthropic-messages",
      baseUrl: "https://fixture.invalid/anthropic",
      model: "shared-model",
      apiKey: "glassbox-fixture-secret",
    });
    const catalog = await PiModelCatalog.open(piDirectory);
    const selected = await configuredPiModel(profiles, "legacy", catalog);

    expect(selected.model).toMatchObject({
      provider: "fixture",
      id: "shared-model",
      contextWindow: 131_072,
      maxTokens: 24_576,
    });
    expect(selected.modelRuntime.getProvider("fixture")).toBeDefined();
    expect(selected.modelRuntime.getProvider("glassbox-legacy")).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
