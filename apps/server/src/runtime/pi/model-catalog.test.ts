import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { PiModelCatalog } from "./model-catalog.js";

it("uses Pi provider models and declared capacities without exposing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-pi-model-catalog-"));
  try {
    const secret = "pi-fixture-secret";
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
            ],
          },
        },
      }),
      "utf8",
    );
    const catalog = await PiModelCatalog.open(directory);
    const profiles = catalog.list();
    const selected = profiles.find((profile) => profile.model === "fixture-model");
    const incomplete = profiles.find((profile) => profile.model === "missing-capacity");

    expect(selected).toMatchObject({
      label: "Fixture Provider / Fixture Model",
      providerId: "fixture",
      contextWindowTokens: 65_536,
      maxOutputTokens: 8_192,
      supportsThinking: true,
      routingAvailable: true,
    });
    expect(JSON.stringify(profiles)).not.toContain(secret);
    if (!selected || !incomplete) throw new Error("Pi fixture models were not loaded");
    expect(incomplete).toMatchObject({ routingAvailable: false });
    expect(() => catalog.resolve(incomplete.id)).toThrow("capacity is unknown");
    expect(catalog.resolve(selected.id).model).toMatchObject({
      provider: "fixture",
      id: "fixture-model",
      contextWindow: 65_536,
      maxTokens: 8_192,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
