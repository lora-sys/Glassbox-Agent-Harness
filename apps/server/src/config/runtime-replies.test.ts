import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { loadRuntimeReplies, parseRuntimeReplies } from "./runtime-replies.js";
import { GATE_MESSAGES } from "../runtime/pi/gate-messages.js";
import { glassboxSystemPrompt } from "../runtime/pi/adapter.js";

it("uses the selected profile's wording in the prompt without changing other profiles", () => {
  const settings = { version: 1, profiles: { "qq-group": { mediaClarify: "请选择输出类型。" } } };
  const resolve = parseRuntimeReplies(settings);
  settings.profiles["qq-group"].mediaClarify = "later edit";
  const selected = resolve("qq-group");
  expect(selected.mediaClarify).toBe("请选择输出类型。");
  expect(Object.isFrozen(selected)).toBe(true);
  expect(resolve("main-agent")).toEqual(GATE_MESSAGES);
  const prompt = glassboxSystemPrompt("Base prompt", {
    sharedConversation: true,
    gateMessages: selected,
  });
  expect(prompt).toContain("请选择输出类型。");
  expect(prompt).not.toContain(GATE_MESSAGES.mediaClarify);
});

it.each([
  null,
  { version: 2, profiles: {} },
  { version: 1, profiles: [] },
  { version: 1, profiles: { unknown: {} } },
  { version: 1, profiles: { "qq-group": { typo: "reply" } } },
  { version: 1, profiles: { "qq-group": { mediaClarify: " " } } },
  { version: 1, profiles: { "qq-group": { mediaClarify: 42 } } },
  { version: 1, profiles: { "qq-group": { mediaClarify: "x".repeat(1001) } } },
  { version: 1, profiles: { "qq-group": { mediaClarify: "bad\u0000reply" } } },
  { version: 1, profiles: {}, authorization: "ALLOW" },
])("rejects invalid reply settings instead of silently ignoring them", (settings) => {
  expect(() => parseRuntimeReplies(settings)).toThrow("invalid_runtime_replies");
});

it("loads optional local settings and rejects oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-replies-"));
  try {
    expect(loadRuntimeReplies(directory)("qq-group")).toEqual(GATE_MESSAGES);
    const file = join(directory, "runtime-replies.json");
    await writeFile(
      file,
      JSON.stringify({ version: 1, profiles: { "qq-group": { mediaClarify: "请选择。" } } }),
    );
    expect(loadRuntimeReplies(directory)("qq-group").mediaClarify).toBe("请选择。");
    await writeFile(file, " ".repeat(64 * 1024 + 1));
    expect(() => loadRuntimeReplies(directory)).toThrow("invalid_runtime_replies");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
