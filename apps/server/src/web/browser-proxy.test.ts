import { once } from "node:events";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProxy, type BrowserProxyOptions } from "./browser-proxy.js";
import type { ResolveWebHost } from "./network-guard.js";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

class FakeUpstream extends Duplex {
  written = "";

  constructor() {
    super();
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const value = chunk.toString("latin1");
    this.written += value;
    if (value.includes("\r\n\r\n")) {
      this.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    } else if (value === "ping") {
      this.push("pong");
    }
    callback();
  }
}

const publicResolver: ResolveWebHost = async () => ["93.184.215.14"];
const proxies: BrowserProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function makeProxy(
  options: Partial<Omit<BrowserProxyOptions, "listenHost" | "advertisedHost">> = {},
) {
  const proxy = new BrowserProxy({
    listenHost: "127.0.0.1",
    advertisedHost: "127.0.0.1",
    resolveHost: publicResolver,
    ...options,
  });
  const endpoint = await proxy.start();
  proxies.push(proxy);
  return { proxy, endpoint, port: Number(new URL(endpoint).port) };
}

async function sendProxyRequest(port: number, request: string): Promise<string> {
  const { connect } = await import("node:net");
  const client = connect(port, "127.0.0.1");
  await once(client, "connect");
  client.write(request);
  const [data] = await once(client, "data");
  client.destroy();
  return (data as Buffer).toString("latin1");
}

describe("browser network proxy", () => {
  it("requires an explicit wildcard opt-in and advertises the isolated network alias", async () => {
    const denied = new BrowserProxy({ listenHost: "0.0.0.0", advertisedHost: "proxy" });
    await expect(denied.start()).rejects.toThrow("browser_proxy_bind_address_required");
    const proxy = new BrowserProxy({
      listenHost: "0.0.0.0",
      advertisedHost: "proxy",
      allowWildcardListen: true,
      resolveHost: publicResolver,
    });
    await proxy.start();
    proxies.push(proxy);
    expect(new URL(await proxy.start()).hostname).toBe("proxy");
  });

  it.each([
    ["http://127.0.0.1/private", "browser_proxy_scheme_denied"],
    ["file:///etc/passwd", "browser_proxy_scheme_denied"],
    ["http://example.com:8080/", "browser_proxy_port_denied"],
    ["http://user:secret@example.com/", "browser_proxy_credentials_denied"],
  ])("rejects unsupported absolute target %s", async (target) => {
    let connects = 0;
    const { port } = await makeProxy({
      connectTo: () => {
        connects++;
        return new FakeUpstream();
      },
    });
    const response = await sendProxyRequest(
      port,
      `GET ${target} HTTP/1.1\r\nHost: example.com\r\n\r\n`,
    );
    expect(response).toContain("403 Forbidden");
    expect(connects).toBe(0);
  });

  it("rejects every private DNS answer before opening an upstream connection", async () => {
    let connects = 0;
    const { port } = await makeProxy({
      resolveHost: async () => ["93.184.215.14", "10.0.0.5"],
      connectTo: () => {
        connects++;
        return new FakeUpstream();
      },
    });
    const response = await sendProxyRequest(
      port,
      "GET http://example.com/private HTTP/1.1\r\nHost: example.com\r\n\r\n",
    );
    expect(response).toContain("403 Forbidden");
    expect(connects).toBe(0);
  });

  it("connects HTTP to a checked DNS address and rewrites absolute-form requests", async () => {
    const dialed: Array<[string, number]> = [];
    let upstream: FakeUpstream | undefined;
    const { port } = await makeProxy({
      connectTo: (address, targetPort) => {
        dialed.push([address, targetPort]);
        upstream = new FakeUpstream();
        queueMicrotask(() => upstream?.emit("connect"));
        return upstream;
      },
    });
    const response = await sendProxyRequest(
      port,
      "GET http://example.com/article?q=1 HTTP/1.1\r\nHost: attacker.invalid\r\nProxy-Authorization: secret\r\n\r\n",
    );
    expect(response).toContain("200 OK");
    expect(dialed).toEqual([["93.184.215.14", 80]]);
    expect(upstream?.written).toContain("GET /article?q=1 HTTP/1.1");
    expect(upstream?.written).toContain("Host: example.com");
    expect(upstream?.written).not.toContain("Proxy-Authorization");
  });

  it("checks CONNECT host and port and pins its socket to a verified IP", async () => {
    const dialed: Array<[string, number]> = [];
    const { port } = await makeProxy({
      connectTo: (address, targetPort) => {
        dialed.push([address, targetPort]);
        const upstream = new FakeUpstream();
        queueMicrotask(() => upstream.emit("connect"));
        return upstream;
      },
    });
    const response = await sendProxyRequest(
      port,
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
    );
    expect(response).toContain("200 Connection Established");
    expect(dialed).toEqual([["93.184.215.14", 443]]);
  });

  it.each([
    "127.0.0.1:443",
    "example.com:22",
    "example.com:65536",
    "example.com:80",
    "example.com:80x",
  ])("rejects unsafe CONNECT target %s", async (target) => {
    let connects = 0;
    const { port } = await makeProxy({
      connectTo: () => {
        connects++;
        return new FakeUpstream();
      },
    });
    const response = await sendProxyRequest(
      port,
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
    );
    expect(response).toContain("403 Forbidden");
    expect(connects).toBe(0);
  });

  it("does not resolve the destination again when dialing an IP literal", async () => {
    let resolveCalls = 0;
    const dialed: string[] = [];
    const { port } = await makeProxy({
      resolveHost: async () => {
        resolveCalls++;
        return ["93.184.215.14"];
      },
      connectTo: (address) => {
        dialed.push(address);
        const upstream = new FakeUpstream();
        queueMicrotask(() => upstream.emit("connect"));
        return upstream;
      },
    });
    const response = await sendProxyRequest(
      port,
      "CONNECT 93.184.215.14:443 HTTP/1.1\r\nHost: 93.184.215.14:443\r\n\r\n",
    );
    expect(response).toContain("200 Connection Established");
    expect(resolveCalls).toBe(0);
    expect(dialed).toEqual(["93.184.215.14"]);
  });

  it("uses the system resolver once and dials the validated DNS literal", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const dialed: string[] = [];
    const { port } = await makeProxy({
      resolveHost: undefined,
      connectTo: (address) => {
        dialed.push(address);
        const upstream = new FakeUpstream();
        queueMicrotask(() => upstream.emit("connect"));
        return upstream;
      },
    });
    const response = await sendProxyRequest(
      port,
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
    );
    expect(response).toContain("200 Connection Established");
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
    expect(dialed).toEqual(["93.184.215.14"]);
  });
});
