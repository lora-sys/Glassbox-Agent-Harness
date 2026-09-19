import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createModelProvider,
  ModelConfigurationError,
  type ModelProfile,
  type ModelProtocol,
} from "./provider.ts";
import { getProviderEnvValue } from "./vendor/pi/utils/provider-env.ts";
import { textResponse, toolResponse } from "./testing/streams.ts";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

const protocols: ModelProtocol[] = ["openai-completions", "openai-responses", "anthropic-messages"];
const profile = (protocol: ModelProtocol): ModelProfile => ({
  id: "test",
  label: "Test",
  protocol,
  baseUrl: "http://127.0.0.1:9898/v1",
  model: "test-model",
  credentialSlot: null,
});
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
afterEach(() => vi.unstubAllEnvs());

describe.each(protocols)("copied Pi %s", (protocol) => {
  it("parses text and reports actual usage through fragmented SSE", async () => {
    const provider = createModelProvider({
      profile: profile(protocol),
      fetch: async () => textResponse(protocol),
    });
    const events = await collect(provider.stream({ context }));
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Hello 群");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      reason: "stop",
      usage: {
        input: 10,
        output: 3,
        totalTokens: 13,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
      },
    });
    expect(provider.capabilities.resume).toBe(false);
  });

  it("keeps unreported token measurements unknown", async () => {
    const provider = createModelProvider({
      profile: profile(protocol),
      fetch: async () => textResponse(protocol, "hello", false),
    });
    const events = await collect(provider.stream({ context }));
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      usage: { input: null, output: null, totalTokens: null, totalSource: null },
    });
  });

  it("assembles fragmented tool arguments", async () => {
    const provider = createModelProvider({
      profile: profile(protocol),
      fetch: async () => toolResponse(protocol),
    });
    const stream = provider.streamForAgent(provider.model, context);
    await collect(stream);
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "read_public",
        arguments: { path: "allowed.txt" },
      }),
    ]);
  });

  it("does not discover a host credential or forward request overrides", async () => {
    vi.stubEnv("OPENAI_API_KEY", "HOST_SECRET_CANARY");
    vi.stubEnv("ANTHROPIC_API_KEY", "HOST_SECRET_CANARY");
    vi.stubEnv("PI_CACHE_RETENTION", "long");
    const seen: string[] = [];
    const provider = createModelProvider({
      profile: profile(protocol),
      fetch: async (_url, request) => {
        seen.push(
          JSON.stringify([...new Headers(request?.headers).entries()]),
          typeof request?.body === "string" ? request.body : "",
        );
        return textResponse(protocol);
      },
    });
    const stream = provider.streamForAgent(provider.model, context, {
      apiKey: "INJECTED_SECRET",
      headers: { authorization: "Bearer injected" },
      env: { OPENAI_API_KEY: "INJECTED_SECRET" },
    });
    await collect(stream);
    expect((await stream.result()).stopReason).toBe("stop");
    expect(seen.join("")).toContain("glassbox-local-no-auth");
    expect(seen.join("")).not.toMatch(/HOST_SECRET_CANARY|INJECTED_SECRET|Bearer injected/);
    expect(getProviderEnvValue("PI_CACHE_RETENTION", {})).toBeUndefined();
  });

  it.each([401, 500])("redacts HTTP %s errors", async (status) => {
    const provider = createModelProvider({
      profile: profile(protocol),
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "PRIVATE_CANARY", type: "error" } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    });
    const events = await collect(provider.stream({ context }));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "provider_failed" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_CANARY");
  });

  it("rejects malformed or incomplete protocol streams", async () => {
    const provider = createModelProvider({
      profile: profile(protocol),
      fetch: async () =>
        new Response('data: {"private":"PRIVATE_CANARY"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const events = await collect(provider.stream({ context }));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "provider_failed" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_CANARY");
  });

  it("cancels before a request without invoking fetch", async () => {
    const fetch = vi.fn(async () => textResponse(protocol));
    const provider = createModelProvider({ profile: profile(protocol), fetch });
    const events = await collect(provider.stream({ context, signal: AbortSignal.abort() }));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request", async () => {
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async (_url, request) => {
      start();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (request?.signal?.aborted) abort();
        else request?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const provider = createModelProvider({ profile: profile(protocol), fetch });
    const pending = collect(provider.stream({ context, signal: controller.signal }));
    await started;
    controller.abort();
    expect((await pending).at(-1)).toMatchObject({ type: "failed", code: "cancelled" });
  });
});

it("rejects unsupported protocols, remote missing credentials and credential URLs", () => {
  expect(() =>
    createModelProvider({
      profile: { ...profile("openai-completions"), protocol: "unsupported" as ModelProtocol },
    }),
  ).toThrow(ModelConfigurationError);
  expect(() =>
    createModelProvider({
      profile: { ...profile("openai-completions"), baseUrl: "https://api.example.test/v1" },
    }),
  ).toThrow("not configured");
  expect(() =>
    createModelProvider({
      profile: { ...profile("openai-completions"), baseUrl: "https://secret@api.example.test/v1" },
      apiKey: "explicit",
    }),
  ).toThrow("Invalid model API address");
  expect(() =>
    createModelProvider({
      profile: { ...profile("openai-completions"), credentialSlot: "missing" },
    }),
  ).toThrow("not configured");
});
