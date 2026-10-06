import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { knownCapacity, PiModelCatalog } from "./model-catalog.js";

it("keeps declared context and output capacities independent", () => {
  expect(knownCapacity(256_000, 256_000)).toEqual({ context: 256_000, output: 256_000 });
  expect(knownCapacity(128_000, 256_000)).toEqual({ context: 128_000, output: 256_000 });
  expect(knownCapacity(128_000, 0)).toEqual({ context: 128_000 });
  expect(knownCapacity(0, 256_000)).toEqual({ output: 256_000 });
  expect(knownCapacity(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1)).toEqual({});
  expect(knownCapacity(undefined, undefined)).toEqual({});
});

it("uses Pi provider models and declared capacities without exposing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-pi-model-catalog-"));
  try {
    const secret = "pi-fixture-secret";
    const codexSecret = "pi-codex-fixture-secret";
    await writeFile(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            name: "Fixture Provider",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: secret,
            models: [
              {
                id: "fixture-model",
                name: "Fixture Model",
                contextWindow: 65_536,
                maxTokens: 8_192,
                reasoning: true,
                input: ["text"],
              },
              { id: "missing-capacity", name: "Missing Capacity" },
              {
                id: "missing-output-capacity",
                name: "Missing Output Capacity",
                contextWindow: 32_768,
              },
              {
                id: "equal-capacity",
                name: "Equal Capacity",
                contextWindow: 256_000,
                maxTokens: 256_000,
              },
            ],
          },
          codexFixture: {
            name: "Codex OAuth Provider",
            api: "openai-codex-responses",
            baseUrl: "http://127.0.0.1:2/codex",
            apiKey: codexSecret,
            models: [
              {
                id: "gpt-fixture",
                name: "GPT Fixture",
                contextWindow: 131_072,
                maxTokens: 16_384,
                reasoning: true,
                input: ["text"],
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const catalog = await PiModelCatalog.open(directory);
    const profiles = catalog.list();
    const selected = profiles.find((profile) => profile.model === "fixture-model");
    const codex = profiles.find((profile) => profile.model === "gpt-fixture");
    const incomplete = profiles.find((profile) => profile.model === "missing-capacity");
    const missingOutput = profiles.find((profile) => profile.model === "missing-output-capacity");
    const equalCapacity = profiles.find((profile) => profile.model === "equal-capacity");

    expect(selected).toMatchObject({
      label: "Fixture Provider / Fixture Model",
      providerId: "fixture",
      contextWindowTokens: 65_536,
      maxOutputTokens: 8_192,
      supportsThinking: true,
      routingAvailable: true,
    });
    expect(JSON.stringify(profiles)).not.toContain(secret);
    expect(JSON.stringify(profiles)).not.toContain(codexSecret);
    expect(codex).toMatchObject({
      label: "Codex OAuth Provider / GPT Fixture",
      providerId: "codexFixture",
      protocol: "openai-codex-responses",
      contextWindowTokens: 131_072,
      maxOutputTokens: 16_384,
      supportsTools: true,
      routingAvailable: true,
    });
    if (!selected || !codex || !incomplete || !missingOutput || !equalCapacity)
      throw new Error("Pi fixture models were not loaded");
    expect(incomplete).not.toHaveProperty("routingAvailable");
    expect(() => catalog.resolve(incomplete.id)).toThrow("capacity is unknown");
    expect(missingOutput).toMatchObject({ contextWindowTokens: 32_768 });
    expect(missingOutput).not.toHaveProperty("maxOutputTokens");
    expect(missingOutput).not.toHaveProperty("routingAvailable");
    expect(() => catalog.resolve(missingOutput.id)).toThrow("capacity is unknown");
    expect(equalCapacity).toMatchObject({
      contextWindowTokens: 256_000,
      maxOutputTokens: 256_000,
      routingAvailable: true,
    });
    expect(catalog.resolve(equalCapacity.id).model).toMatchObject({
      contextWindow: 256_000,
      maxTokens: 256_000,
    });
    expect(catalog.resolve(selected.id).model).toMatchObject({
      provider: "fixture",
      id: "fixture-model",
      contextWindow: 65_536,
      maxTokens: 8_192,
    });
    expect(catalog.resolve(codex.id).model).toMatchObject({
      provider: "codexFixture",
      id: "gpt-fixture",
      api: "openai-codex-responses",
      contextWindow: 131_072,
      maxTokens: 16_384,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
