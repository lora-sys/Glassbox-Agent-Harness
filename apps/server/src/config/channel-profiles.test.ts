import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ChannelProfileStore } from "./channel-profiles.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "glassbox channels "));
  directories.push(directory);
  return { directory, store: await ChannelProfileStore.open(directory) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const input = {
  id: "qq-personal",
  label: "我的 QQ 助理",
  kind: "qq-onebot",
  endpoint: "ws://127.0.0.1:6700/",
  botId: "12345",
  ownerId: "54321",
  groupIds: ["77777"],
  executionRef: "claude-code",
};

describe("server-owned channel profiles", () => {
  it("persists configuration and credentials without exposing secrets or implying a connection", async () => {
    const { directory, store } = await fixture();
    const saved = await store.save({ ...input, token: "fixture-qq-private-token" });
    expect(saved).toEqual({
      ...input,
      tokenConfigured: true,
      autoConnect: false,
      connectionState: "disconnected",
    });
    expect(JSON.stringify(store.list())).not.toContain("fixture-qq-private-token");
    expect(saved).not.toHaveProperty("credentialSlot");
    expect(saved).not.toHaveProperty("token");
    const reopened = await ChannelProfileStore.open(directory);
    expect(reopened.resolve(input.id)).toMatchObject({
      token: "fixture-qq-private-token",
      executionRef: "claude-code",
      autoConnect: false,
      config: {
        connectionId: input.id,
        botId: input.botId,
        ownerId: input.ownerId,
        allowRemote: false,
      },
    });
  });

  it("preserves, replaces and clears a token while keeping the channel identity stable", async () => {
    const { directory, store } = await fixture();
    await store.save({ ...input, token: "first-private-token" });
    const firstSlot = store.resolve(input.id).config.credentialSlot;
    await store.save({ ...input, label: "改名" });
    expect(store.resolve(input.id).token).toBe("first-private-token");
    await store.save({ ...input, token: "replacement-token" });
    expect(store.resolve(input.id).config.credentialSlot).toBe(firstSlot);
    expect(store.resolve(input.id).token).toBe("replacement-token");
    expect(await readFile(join(directory, "channels.json"), "utf8")).not.toContain(
      "first-private-token",
    );
    await store.save({ ...input, token: null });
    expect((await ChannelProfileStore.open(directory)).resolve(input.id).token).toBeUndefined();
    expect(store.list()[0]?.tokenConfigured).toBe(false);
    expect(await readFile(join(directory, "channels.json"), "utf8")).not.toContain(
      "replacement-token",
    );
  });

  it("requires a token choice before changing an endpoint origin and keeps state after rejection", async () => {
    const { store } = await fixture();
    await store.save({ ...input, token: "origin-private-token" });
    await expect(store.save({ ...input, endpoint: "ws://127.0.0.1:6701/" })).rejects.toThrow(
      "requires replacing or removing",
    );
    expect(store.resolve(input.id).config.endpoint).toBe(input.endpoint);
    await store.save({ ...input, endpoint: "ws://localhost:6700/combined" });
    expect(store.resolve(input.id).token).toBe("origin-private-token");
    await store.save({ ...input, endpoint: "ws://127.0.0.1:6701/", token: "new-origin-token" });
    expect(store.resolve(input.id).token).toBe("new-origin-token");
    await store.save({ ...input, token: null });
    expect(store.resolve(input.id).token).toBeUndefined();
  });

  it("keeps each channel credential and scope separate, including mutations to returned arrays", async () => {
    const { store } = await fixture();
    await store.save({ ...input, token: "channel-one-token" });
    await store.save({
      ...input,
      id: "second",
      botId: "22222",
      ownerId: "33333",
      groupIds: ["88888"],
      token: "channel-two-token",
    });
    store.list()[0]?.groupIds.push("99999");
    expect(store.resolve(input.id).config.groupIds).toEqual(["77777"]);
    expect(() => (store.resolve(input.id).config.groupIds as string[]).push("99999")).toThrow();
    await store.save({ ...input, token: null });
    expect(store.resolve("second")).toMatchObject({
      token: "channel-two-token",
      config: { botId: "22222", ownerId: "33333", groupIds: ["88888"] },
    });
  });

  it("serializes saves and explicit restart intent without persisting a live connection state", async () => {
    const { directory, store } = await fixture();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => store.save({ ...input, id: `channel${index}` })),
    );
    await Promise.all([
      store.setAutoConnect("channel0", true),
      store.save({ ...input, id: "channel0", executionRef: "model:daily" }),
    ]);
    const reopened = await ChannelProfileStore.open(directory);
    expect(reopened.list()).toHaveLength(12);
    expect(reopened.list().find((channel) => channel.id === "channel0")).toMatchObject({
      autoConnect: true,
      connectionState: "disconnected",
      executionRef: "model:daily",
    });
    await reopened.setAutoConnect("channel0", false);
    expect((await ChannelProfileStore.open(directory)).resolve("channel0").autoConnect).toBe(false);
    expect(await readFile(join(directory, "channels.json"), "utf8")).not.toContain(
      "connectionState",
    );
  });

  it.each([
    { credentialSlot: "other-credential" },
    { active: true },
    { autoConnect: true },
    { connectionState: "connected" },
    { lastError: "private payload" },
    { allowRemote: true },
    { kind: "qq-official" },
    { endpoint: "wss://example.test/" },
    { endpoint: "ws://secret:private@127.0.0.1/" },
    { endpoint: "ws://127.0.0.1/?token=private" },
    { endpoint: "ws://127.0.0.1/api" },
    { botId: "54321" },
    { botId: 12345 },
    { ownerId: "9007199254740992" },
    { groupIds: [77777] },
    { groupIds: Array.from({ length: 33 }, (_, i) => String(i + 1)) },
    { label: "bad\nlabel" },
    { token: "bad token" },
    { token: "" },
    { executionRef: "model:../private" },
    { id: "../escape" },
  ])("rejects invalid and server-owned input fields %j", async (changes) => {
    const { store } = await fixture();
    expect(() => store.save({ ...input, ...changes })).toThrow();
    expect(store.list()).toEqual([]);
  });

  it("defaults execution, normalizes groups, and supports the configured model and Codex references", async () => {
    const { store } = await fixture();
    const { executionRef: _execution, ...withoutExecution } = input;
    await store.save({ ...withoutExecution, groupIds: ["77777", "77777"] });
    expect(store.resolve(input.id).executionRef).toBe("claude-code");
    expect(store.list()[0]?.groupIds).toEqual(["77777"]);
    await store.save({ ...input, executionRef: "codex" });
    expect(store.resolve(input.id).executionRef).toBe("codex");
  });

  it("fails closed on a corrupt file without echoing or overwriting private source", async () => {
    const { directory } = await fixture();
    const path = join(directory, "channels.json");
    const corrupted = '{"credentials":{"private-token":"do-not-display';
    await writeFile(path, corrupted);
    await expect(ChannelProfileStore.open(directory)).rejects.toThrow(
      "Cannot read channel configuration",
    );
    expect(await readFile(path, "utf8")).toBe(corrupted);
  });

  it("rejects a malformed file that shares a slot between identities", async () => {
    const { directory } = await fixture();
    await writeFile(
      join(directory, "channels.json"),
      JSON.stringify({
        version: 1,
        channels: [
          { ...input, credentialSlot: "shared", autoConnect: false },
          { ...input, id: "second", credentialSlot: "shared", autoConnect: false },
        ],
        credentials: { shared: "private-token" },
      }),
    );
    await expect(ChannelProfileStore.open(directory)).rejects.toThrow(
      "Cannot read channel configuration",
    );
  });

  it("prunes orphan credentials before adding a token at the file credential limit", async () => {
    const { directory } = await fixture();
    await writeFile(
      join(directory, "channels.json"),
      JSON.stringify({
        version: 1,
        channels: [{ ...input, credentialSlot: "owned", autoConnect: false }],
        credentials: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`orphan${index}`, "orphan-private-token"]),
        ),
      }),
    );
    const store = await ChannelProfileStore.open(directory);
    await store.save({ ...input, token: "owned-private-token" });
    const reopened = await ChannelProfileStore.open(directory);
    expect(reopened.resolve(input.id).token).toBe("owned-private-token");
    expect(await readFile(join(directory, "channels.json"), "utf8")).not.toContain(
      "orphan-private-token",
    );
  });

  it("bounds profile count while allowing edits to existing stable identifiers", async () => {
    const { directory } = await fixture();
    await writeFile(
      join(directory, "channels.json"),
      JSON.stringify({
        version: 1,
        channels: Array.from({ length: 100 }, (_, index) => ({
          ...input,
          id: `channel${index}`,
          credentialSlot: `slot${index}`,
          autoConnect: false,
        })),
        credentials: {},
      }),
    );
    const store = await ChannelProfileStore.open(directory);
    await expect(store.save(input)).rejects.toThrow("Too many channel profiles");
    await store.save({ ...input, id: "channel0", token: "fixture-token" });
    expect(store.list()).toHaveLength(100);
    expect(store.resolve("channel0").token).toBe("fixture-token");
  });

  it("leaves memory unchanged and cleans temporary files when atomic replacement fails", async () => {
    const { directory, store } = await fixture();
    await mkdir(join(directory, "channels.json"));
    await expect(store.save(input)).rejects.toThrow("Could not save channel configuration");
    expect(store.list()).toEqual([]);
    expect(await readdir(directory)).toEqual(["channels.json"]);
  });

  it("requires an absolute data directory and reports missing identities safely", async () => {
    await expect(ChannelProfileStore.open("relative")).rejects.toThrow("must be absolute");
    const { store } = await fixture();
    expect(() => store.resolve("private-nonexistent")).toThrow("Channel profile not found");
    await expect(store.setAutoConnect("private-nonexistent", true)).rejects.toThrow(
      "Channel profile not found",
    );
  });
});
