import { describe, expect, it, vi } from "vite-plus/test";
import { runCli } from "./run.ts";
import { publicOutput } from "./output.ts";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function requestBody(body: RequestInit["body"]): Record<string, unknown> {
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(body);
}
const modelArgs = [
  "models",
  "set",
  "personal",
  "--label",
  "Personal model",
  "--protocol",
  "openai-responses",
  "--base-url",
  "https://api.example.test/v1",
  "--model",
  "example-model",
];

function fixture(response: unknown = { status: "ready" }, status = 200) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => jsonResponse(response, status));
  return {
    resolveConnection: vi.fn(async () => ({
      baseUrl: "http://localhost:8741",
      token: "local-management-secret",
    })),
    startServer: vi.fn(async () => ({ status: "ready", port: 8741 })),
    readSecret: vi.fn(async () => "model-key-from-stdin"),
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>(),
    clientOptions: { fetch },
  };
}

describe("unified CLI commands", () => {
  it("shows help without loading credentials or starting a service", async () => {
    const dependencies = fixture();
    expect(await runCli(["--help"], dependencies)).toBe(0);
    expect(dependencies.stdout.mock.calls[0]?.[0]).toContain("models set <id>");
    expect(dependencies.resolveConnection).not.toHaveBeenCalled();
    expect(dependencies.startServer).not.toHaveBeenCalled();
  });

  it.each(
    [
      ["unknown"],
      ["status", "extra"],
      ["status", "--model", "wrong-command"],
      ["runs", "cancel"],
      ["runs", "show", "../private"],
      ["status", "--json", "--json"],
      [...modelArgs, "--api-key", "do-not-echo-this"],
      [...modelArgs, "--api-key-stdin", "--clear-api-key"],
      ["models", "set", "incomplete"],
      ["channels", "save", "--token", "do-not-echo-this"],
      ["channels", "save", "config.json"],
      ["channels", "connect", "../private"],
      ["channels", "connect", "qq", "--cursor", "unexpected"],
      ["runs", "show", "run:private"],
      ["trace", "show", "run-1", "--cursor", "cursor&token=do-not-echo-this"],
      ["trace", "group-role-audit", "p3-qq"],
      ["trace", "group-role-audit", "p3-qq", "not-a-group"],
      ["trace", "group-role-audit", "../private", "1126022432"],
      ["trace", "group-role-audit", "p3-qq", "1126022432", "extra"],
      ["runs", "list", "--cursor", "x".repeat(1025)],
      ["eval", "run"],
      ["eval", "list"],
      ["eval", "run", "run-1", "--run-id", "run-2"],
      ["eval", "run", "run-1", "--cursor", "unexpected"],
      [...modelArgs, "--protocol", "unsupported"],
    ].map((args) => ({ args })),
  )("rejects bad arguments before side effects", async ({ args }) => {
    const dependencies = fixture();
    expect(await runCli(args, dependencies)).toBe(2);
    expect(dependencies.resolveConnection).not.toHaveBeenCalled();
    expect(dependencies.readSecret).not.toHaveBeenCalled();
    expect(dependencies.startServer).not.toHaveBeenCalled();
    expect(JSON.stringify(dependencies.stderr.mock.calls)).not.toContain("do-not-echo-this");
  });

  it.each([
    [["status"], "GET", "/manage/status"],
    [["doctor"], "GET", "/manage/doctor"],
    [["models", "list"], "GET", "/manage/models"],
    [["channels", "list"], "GET", "/manage/channels"],
    [["channels", "connect", "qq_test"], "POST", "/manage/channels/qq_test/connect"],
    [["channels", "disconnect", "qq_test"], "POST", "/manage/channels/qq_test/disconnect"],
    [["conversations", "list"], "GET", "/manage/conversations"],
    [["runs", "list"], "GET", "/manage/runs"],
    [["runs", "show", "run-1"], "GET", "/manage/runs/run-1"],
    [["runs", "trace", "run-1"], "GET", "/manage/runs/run-1/trace"],
    [["trace", "show", "run-1"], "GET", "/manage/runs/run-1/trace"],
    [
      ["trace", "group-role-audit", "p3-qq", "1126022432"],
      "GET",
      "/manage/group-role-audit?channelId=p3-qq&groupId=1126022432",
    ],
    [["runs", "cancel", "run-1"], "POST", "/manage/runs/run-1/cancel"],
    [["runs", "retry", "run-1"], "POST", "/manage/runs/run-1/retry"],
    [["eval", "list", "run-1"], "GET", "/manage/runs/run-1/evals"],
    [["eval", "run", "run-1"], "POST", "/manage/runs/run-1/evals"],
    [["eval", "run", "--run-id", "run-1"], "POST", "/manage/runs/run-1/evals"],
  ] as const)("routes %s to the common management API", async (args, method, path) => {
    const dependencies = fixture();
    expect(await runCli(args, dependencies)).toBe(0);
    expect(dependencies.clientOptions.fetch).toHaveBeenCalledWith(
      `http://localhost:8741${path}`,
      expect.objectContaining({ method }),
    );
  });

  it("preserves the server's cancellation pending state", async () => {
    const dependencies = fixture({
      run: { id: "run-1", status: "cancel_requested", cancellation: "pending" },
    });
    expect(await runCli(["runs", "cancel", "run-1", "--json"], dependencies)).toBe(0);
    expect(JSON.parse(dependencies.stdout.mock.calls[0]?.[0] ?? "")).toEqual({
      ok: true,
      data: { run: { id: "run-1", status: "cancel_requested", cancellation: "pending" } },
    });
  });

  it("starts the fixed Eval suite for one explicit Run", async () => {
    const dependencies = fixture();
    expect(await runCli(["eval", "run", "private-isolation"], dependencies)).toBe(0);
    expect(dependencies.clientOptions.fetch).toHaveBeenCalledWith(
      "http://localhost:8741/manage/runs/private-isolation/evals",
      expect.objectContaining({ body: JSON.stringify({ suiteId: "run-integrity-v1" }) }),
    );
  });

  it("probes one explicitly named acceptance group", async () => {
    const dependencies = fixture({ probe: { groupId: "1126022432", complete: true } });
    expect(
      await runCli(["capabilities", "probe", "p3-qq", "1126022432", "--json"], dependencies),
    ).toBe(0);
    expect(dependencies.clientOptions.fetch).toHaveBeenCalledWith(
      "http://localhost:8741/manage/capabilities/probe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ channelId: "p3-qq", groupId: "1126022432" }),
      }),
    );
  });

  it.each([
    // A probe that guessed its target could call a group nobody meant to touch, so there is
    // no default group and a non-numeric one never reaches the server.
    [["capabilities", "probe", "p3-qq"]],
    [["capabilities", "probe", "p3-qq", "not-a-group"]],
    [["capabilities", "probe", "p3-qq", "0"]],
    [["capabilities", "probe", "p3-qq", "1126022432", "extra"]],
  ] as const)("refuses an incomplete probe request for %s", async (args) => {
    const dependencies = fixture();
    expect(await runCli([...args], dependencies)).toBe(2);
    expect(dependencies.clientOptions.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [["conversations", "list"], "/manage/conversations"],
    [["runs", "list"], "/manage/runs"],
    [["trace", "show", "run-1"], "/manage/runs/run-1/trace"],
    [["runs", "trace", "run-1"], "/manage/runs/run-1/trace"],
    [["eval", "list", "--run-id", "run-1"], "/manage/runs/run-1/evals"],
  ] as const)("preserves an opaque cursor for %s", async (args, path) => {
    const dependencies = fixture({ items: [], nextCursor: "opaque_next_page" });
    expect(await runCli([...args, "--cursor", "gbxtrc_abc-123", "--json"], dependencies)).toBe(0);
    expect(dependencies.clientOptions.fetch).toHaveBeenCalledWith(
      `http://localhost:8741${path}?cursor=gbxtrc_abc-123`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.parse(dependencies.stdout.mock.calls[0]![0]).data.nextCursor).toBe(
      "opaque_next_page",
    );
  });

  it("saves and reads profiles through one backend store", async () => {
    const dependencies = fixture();
    let stored: Record<string, unknown> | undefined;
    dependencies.clientOptions.fetch.mockImplementation(async (_url, options) => {
      if (options?.method === "POST") {
        const body = requestBody(options.body);
        expect(body.apiKey).toBe("model-key-from-stdin");
        const { apiKey: _apiKey, ...profile } = body;
        stored = { ...profile, credentialConfigured: true };
        return jsonResponse({ profile: stored });
      }
      return jsonResponse({ profiles: stored ? [stored] : [] });
    });
    expect(await runCli([...modelArgs, "--api-key-stdin", "--json"], dependencies)).toBe(0);
    expect(await runCli(["models", "list", "--json"], dependencies)).toBe(0);
    const results = dependencies.stdout.mock.calls.map(([text]) => JSON.parse(text));
    expect(results[1].data.profiles[0]).toEqual(results[0].data.profile);
    expect(results[0].data.profile).toEqual({
      id: "personal",
      label: "Personal model",
      protocol: "openai-responses",
      baseUrl: "https://api.example.test/v1",
      model: "example-model",
      credentialConfigured: true,
    });
    expect(JSON.stringify(results)).not.toContain("model-key-from-stdin");
  });

  it("omits the key when preserving and sends null when clearing", async () => {
    const dependencies = fixture();
    expect(await runCli(modelArgs, dependencies)).toBe(0);
    const firstBody = requestBody(dependencies.clientOptions.fetch.mock.calls[0]?.[1]?.body);
    expect(firstBody).not.toHaveProperty("apiKey");
    expect(await runCli([...modelArgs, "--clear-api-key"], dependencies)).toBe(0);
    const secondBody = requestBody(dependencies.clientOptions.fetch.mock.calls[1]?.[1]?.body);
    expect(secondBody.apiKey).toBeNull();
    expect(dependencies.readSecret).not.toHaveBeenCalled();
  });

  it.each(["", "\n", "multiple\nlines", "bad\u0000key", "x".repeat(16385)])(
    "rejects missing or invalid stdin keys without a request",
    async (key) => {
      const dependencies = fixture();
      dependencies.readSecret.mockResolvedValue(key);
      expect(await runCli([...modelArgs, "--api-key-stdin"], dependencies)).toBe(1);
      expect(dependencies.clientOptions.fetch).not.toHaveBeenCalled();
      expect(dependencies.resolveConnection).not.toHaveBeenCalled();
    },
  );

  it("hides credentials in returned objects while preserving token usage", async () => {
    const dependencies = fixture({
      profile: {
        apiKey: "unexpected-secret",
        credentialSlot: "private-slot",
        credentialConfigured: true,
      },
      run: {
        inputTokens: 12,
        outputTokens: 8,
        tokenUsage: { totalTokens: 20 },
        raw: "model-key-from-stdin",
      },
      nested: { authorization: "Bearer local-management-secret", accessToken: "another-secret" },
    });
    expect(await runCli([...modelArgs, "--api-key-stdin", "--json"], dependencies)).toBe(0);
    expect(JSON.parse(dependencies.stdout.mock.calls[0]?.[0] ?? "").data).toEqual({
      profile: { credentialConfigured: true },
      run: { inputTokens: 12, outputTokens: 8, tokenUsage: { totalTokens: 20 }, raw: "[redacted]" },
      nested: {},
    });
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "FORBIDDEN"],
    [404, "NOT_AVAILABLE"],
  ] as const)("exits nonzero on HTTP %s without printing server payloads", async (status, code) => {
    const dependencies = fixture(
      { error: { code, message: "SECRET_UPSTREAM_BODY", stack: "PRIVATE_STACK" } },
      status,
    );
    expect(await runCli(["runs", "cancel", "run-1", "--json"], dependencies)).toBe(1);
    const text = dependencies.stdout.mock.calls[0]?.[0] ?? "";
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code } });
    expect(text).not.toContain("SECRET_UPSTREAM_BODY");
    expect(text).not.toContain("PRIVATE_STACK");
  });

  it("uses only the injected startup implementation for serve", async () => {
    const dependencies = fixture();
    expect(await runCli(["serve", "--json"], dependencies)).toBe(0);
    expect(dependencies.startServer).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveConnection).not.toHaveBeenCalled();
    expect(JSON.parse(dependencies.stdout.mock.calls[0]?.[0] ?? "")).toEqual({
      ok: true,
      data: { status: "ready", port: 8741 },
    });
  });

  it("does not claim serve is available before entrypoint wiring", async () => {
    const { startServer: _startServer, ...dependencies } = fixture();
    expect(await runCli(["serve", "--json"], dependencies)).toBe(1);
    expect(JSON.parse(dependencies.stdout.mock.calls[0]?.[0] ?? "")).toMatchObject({
      ok: false,
      error: { code: "NOT_AVAILABLE" },
    });
  });

  it("bounds output traversal", () => {
    let data: unknown = {};
    for (let count = 0; count < 45; count++) data = { data };
    expect(() => publicOutput(data)).toThrow(/invalid management response/u);
  });
});
