import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { ModelProfileStore } from "../../config/model-profiles.js";
import { configuredPiModel } from "./configured-model.js";

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
      contextWindowTokens: 8192,
      maxOutputTokens: 1024,
    };
    await profiles.save(config);
    const first = await configuredPiModel(profiles, "local");
    expect(first.model).toMatchObject({
      id: "first",
      api: "openai-completions",
      baseUrl: config.baseUrl,
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
