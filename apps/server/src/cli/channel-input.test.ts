import { describe, expect, it, vi } from "vite-plus/test";
import { parseChannelInput } from "./channel-input.ts";
import { runCli } from "./run.ts";

const channel = {
  id: "personal-qq",
  label: "本机 QQ",
  kind: "qq-onebot",
  endpoint: "ws://127.0.0.1:6700/",
  botId: "10001",
  ownerId: "10002",
  groupIds: ["10003"],
  executionRef: "claude-code",
  token: "channel-private-token",
};
function fixture(raw = JSON.stringify(channel)) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        channel: {
          ...channel,
          raw: channel.token,
          tokenConfigured: true,
          connectionState: "disconnected",
          autoConnect: false,
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  return {
    readInput: vi.fn(async () => raw),
    readSecret: vi.fn(async () => "unneeded-model-key"),
    resolveConnection: vi.fn(async () => ({
      baseUrl: "http://localhost:8741",
      token: "management-private-token",
    })),
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>(),
    clientOptions: { fetch },
  };
}

describe("channel JSON input", () => {
  it("saves through the shared endpoint and never prints the submitted token", async () => {
    const dependencies = fixture();
    expect(await runCli(["channels", "save", "--json"], dependencies)).toBe(0);
    expect(dependencies.readInput).toHaveBeenCalledOnce();
    expect(dependencies.readSecret).not.toHaveBeenCalled();
    expect(dependencies.clientOptions.fetch).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:8741/manage/channels",
      expect.objectContaining({ method: "POST", body: JSON.stringify(channel) }),
    );
    const output = dependencies.stdout.mock.calls[0]![0];
    expect(output).not.toContain(channel.token);
    expect(JSON.parse(output).data.channel).toMatchObject({
      tokenConfigured: true,
      connectionState: "disconnected",
      autoConnect: false,
      raw: "[redacted]",
    });
  });

  it("preserves an omitted token and sends an explicit null when clearing", () => {
    const { token: _token, ...withoutToken } = channel;
    expect(parseChannelInput(JSON.stringify(withoutToken))).not.toHaveProperty("token");
    expect(parseChannelInput(JSON.stringify({ ...channel, token: null })).token).toBeNull();
  });

  it.each([
    "{bad-secret-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...channel, token: "" }),
    JSON.stringify({ ...channel, token: "bad\nkey" }),
    JSON.stringify({ ...channel, ownerId: 10002 }),
    JSON.stringify({ ...channel, groupIds: [10003] }),
    JSON.stringify({ ...channel, endpoint: "ws://user:secret@127.0.0.1" }),
    JSON.stringify({ ...channel, endpoint: "ws://127.0.0.1/?token=secret" }),
    JSON.stringify({ ...channel, endpoint: "wss://example.org" }),
    JSON.stringify({ ...channel, executionRef: "owner-shell" }),
    JSON.stringify({ ...channel, credentialSlot: "private-slot" }),
    JSON.stringify({ ...channel, autoConnect: true }),
  ])("rejects invalid channel input before credentials or HTTP are accessed", async (raw) => {
    const dependencies = fixture(raw);
    expect(await runCli(["channels", "save", "--json"], dependencies)).toBe(2);
    expect(dependencies.resolveConnection).not.toHaveBeenCalled();
    expect(dependencies.clientOptions.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(dependencies.stdout.mock.calls[0]![0])).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(dependencies.stdout.mock.calls[0]![0]).not.toContain("secret");
  });

  it("rejects missing and oversized stdin without contacting the server", async () => {
    const dependencies = fixture("x".repeat(65537));
    expect(await runCli(["channels", "save"], dependencies)).toBe(1);
    expect(dependencies.resolveConnection).not.toHaveBeenCalled();
    expect(await runCli(["channels", "save"], { ...dependencies, readInput: undefined })).toBe(1);
  });

  it("uses fixed channel errors without exposing a failed response body", async () => {
    const dependencies = fixture();
    dependencies.clientOptions.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "CHANNEL_ACTIVE", message: "secret=private-channel-token" },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await runCli(["channels", "save", "--json"], dependencies)).toBe(1);
    const output = dependencies.stdout.mock.calls[0]![0];
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: "CHANNEL_ACTIVE" } });
    expect(output).not.toContain("private-channel-token");
  });
});
