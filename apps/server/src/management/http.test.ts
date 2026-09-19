import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ModelProfileStore } from "../config/model-profiles.js";
import { createManagementAccess, loadManagementToken } from "./access.js";
import { createManagementHandler } from "./http.js";

const fixtures: { directory: string; server: Server }[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "glassbox management "));
  const models = await ModelProfileStore.open(directory);
  const token = await loadManagementToken(directory);
  let authorize: ReturnType<typeof createManagementAccess>;
  const handler = createManagementHandler({
    authorize: (request) => authorize(request),
    models,
    status: () => ({ running: true }),
    doctor: () => ({ providers: [] }),
  });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  fixtures.push({ directory, server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  const host = `127.0.0.1:${address.port}`;
  authorize = createManagementAccess({
    token,
    allowedHosts: [host],
    allowedOrigins: ["http://127.0.0.1:5173"],
  });
  return {
    directory,
    models,
    token,
    url: `http://${host}/manage`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}

afterEach(async () => {
  for (const { server, directory } of fixtures.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

const model = {
  id: "fixture",
  label: "Fixture",
  protocol: "openai-completions",
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "fixture",
};

describe("shared management boundary", () => {
  it("requires the same key for CLI and browser access and rejects a hostile Origin", async () => {
    const { url, headers, directory, token } = await fixture();
    expect(await loadManagementToken(directory)).toBe(token);
    expect((await fetch(`${url}/models`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/models`, {
          headers: { ...headers, authorization: `Bearer ${randomBytes(32).toString("base64url")}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/models`, {
          headers: { ...headers, origin: "https://untrusted.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${url}/models`, { headers: { ...headers, origin: "http://127.0.0.1:5173" } }))
        .status,
    ).toBe(200);
    expect((await fetch(`${url}/models`, { headers })).status).toBe(200);
  });

  it("saves once through the API and returns the same public configuration to both clients", async () => {
    const { url, headers, models } = await fixture();
    const saved = await fetch(`${url}/models`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...model, apiKey: "disposable-credential" }),
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(await saved.text()).not.toContain("disposable-credential");
    const cliView = await (await fetch(`${url}/models`, { headers })).json();
    const browserView = await (
      await fetch(`${url}/models`, { headers: { ...headers, origin: "http://127.0.0.1:5173" } })
    ).json();
    expect(cliView).toEqual(browserView);
    expect(cliView).toEqual({ profiles: models.list() });
    expect(models.resolve("fixture").apiKey).toBe("disposable-credential");
  });

  it("bounds and validates request bodies and does not expose malformed credential fragments", async () => {
    const { url, headers, models } = await fixture();
    const malformed = await fetch(`${url}/models`, {
      method: "POST",
      headers,
      body: '{"apiKey":"test-private-malformed',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("test-private-malformed");
    expect(
      (
        await fetch(`${url}/models`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...model, apiKey: "a".repeat(70000) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(`${url}/models`, {
          method: "POST",
          headers: { ...headers, "content-type": "text/plain" },
          body: JSON.stringify(model),
        })
      ).status,
    ).toBe(415);
    expect(models.list()).toEqual([]);
  });

  it("does not report unimplemented task controls as successful", async () => {
    const { url, headers } = await fixture();
    const result = await fetch(`${url}/runs/fake/cancel`, { method: "POST", headers });
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({
      error: { code: "NOT_AVAILABLE", message: "This management operation is not available" },
    });
  });
});
