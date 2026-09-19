import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ModelProfileStore } from "./model-profiles.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "glassbox profiles "));
  directories.push(directory);
  return { directory, store: await ModelProfileStore.open(directory) };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const profile = {
  id: "local",
  label: "Local model",
  protocol: "openai-completions",
  model: "configured-model",
  baseUrl: "http://127.0.0.1:8888/v1",
};

describe("model configuration", () => {
  it("keeps keys out of public profiles and survives a reopen", async () => {
    const { directory, store } = await fixture();
    await store.save({ ...profile, apiKey: "test-secret-123" });
    expect(JSON.stringify(store.list())).not.toContain("test-secret-123");
    expect(store.list()[0]).not.toHaveProperty("credentialSlot");
    const reopened = await ModelProfileStore.open(directory);
    expect(reopened.resolve("local").apiKey).toBe("test-secret-123");
    await reopened.save({ ...profile, label: "Renamed" });
    expect(reopened.resolve("local").apiKey).toBe("test-secret-123");
    await reopened.save({ ...profile, apiKey: null });
    expect(reopened.resolve("local").apiKey).toBeUndefined();
    expect(await readFile(join(directory, "models.json"), "utf8")).not.toContain("test-secret-123");
  });

  it("does not lose unrelated concurrent profile saves", async () => {
    const { directory, store } = await fixture();
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.save({ ...profile, id: `model${index}` })));
    expect((await ModelProfileStore.open(directory)).list()).toHaveLength(12);
  });

  it("requires an explicit credential choice when changing the destination", async () => {
    const { store } = await fixture();
    await store.save({ ...profile, apiKey: "private-key" });
    await expect(store.save({ ...profile, baseUrl: "https://another.example/v1" })).rejects.toThrow("requires replacing or removing");
    expect(store.resolve("local").profile.baseUrl).toBe(profile.baseUrl);
    await store.save({ ...profile, baseUrl: "https://another.example/v1", apiKey: null });
    expect(store.resolve("local").apiKey).toBeUndefined();
  });

  it("reopens a maximum-length profile identifier with its credential", async () => {
    const { directory, store } = await fixture();
    const id = "a".repeat(80);
    await store.save({ ...profile, id, apiKey: "fixture" });
    expect((await ModelProfileStore.open(directory)).resolve(id).apiKey).toBe("fixture");
  });

  it("preserves credentials still referenced by another profile and prunes replaced slots", async () => {
    const { directory } = await fixture();
    await writeFile(join(directory, "models.json"), JSON.stringify({
      version: 1,
      profiles: [
        { ...profile, id: "first", credentialSlot: "shared" },
        { ...profile, id: "second", credentialSlot: "shared" },
      ],
      credentials: { shared: "shared-key", ...Object.fromEntries(Array.from({ length: 99 }, (_, index) => [`orphan${index}`, "old-secret"])) },
    }));
    const store = await ModelProfileStore.open(directory);
    await store.save({ ...profile, id: "first", apiKey: null });
    expect((await ModelProfileStore.open(directory)).resolve("second").apiKey).toBe("shared-key");
    await store.save({ ...profile, id: "second", apiKey: "replacement-key" });
    const reopened = await ModelProfileStore.open(directory);
    expect(reopened.resolve("second").apiKey).toBe("replacement-key");
    const saved = await readFile(join(directory, "models.json"), "utf8");
    expect(saved).not.toContain("shared-key");
    expect(saved).not.toContain("old-secret");
  });

  it("rejects embedded URL secrets and untrusted credential slots without echoing input", async () => {
    const { store } = await fixture();
    expect(() => store.save({ ...profile, baseUrl: "https://secret:password@example.com/v1" })).toThrow("API address cannot contain");
    expect(() => store.save({ ...profile, baseUrl: "https://example.com?key=secret" })).toThrow("API address cannot contain");
    expect(() => store.save({ ...profile, credentialSlot: "someone-else" })).toThrow("Unknown model profile field");
    expect(() => store.save({ ...profile, baseUrl: "http://example.com/v1" })).toThrow("requires HTTPS");
    expect(store.list()).toEqual([]);
  });

  it("reports corrupt configuration without disclosing parser fragments or overwriting the file", async () => {
    const { directory } = await fixture();
    const path = join(directory, "models.json");
    const corrupted = '{"credentials":{"test":"test-private-value';
    await writeFile(path, corrupted);
    await expect(ModelProfileStore.open(directory)).rejects.toThrow("Cannot read model configuration");
    expect(await readFile(path, "utf8")).toBe(corrupted);
  });
});
