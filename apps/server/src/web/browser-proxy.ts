import {
  createServer as createTcpServer,
  connect as tcpConnect,
  type Server,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";
import { isIP } from "node:net";
import { assertPublicWebUrl, systemResolveWebHost, type ResolveWebHost } from "./network-guard.js";

const MAX_HEADER_BYTES = 32_768;
const ALLOWED_PORTS = new Set([80, 443]);

export type BrowserProxyConnector = (address: string, port: number) => Duplex;

export interface BrowserProxyHandle {
  start(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserProxyOptions {
  /** Interface reachable from the isolated browser container. Wildcards require explicit opt-in. */
  listenHost: string;
  /** Use a fixed sidecar port when the browser container address is preconfigured. */
  listenPort?: number;
  /** The sidecar deployment may explicitly opt into binding its isolated network interfaces. */
  allowWildcardListen?: boolean;
  /** Host or IP by which the isolated browser container reaches this listener. */
  advertisedHost: string;
  resolveHost?: ResolveWebHost;
  connectTo?: BrowserProxyConnector;
}

interface Target {
  url: URL;
  address: string;
  port: number;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function withPort(scheme: "http" | "https", host: string, port: number): string {
  const normalizedHost = stripIpv6Brackets(host);
  const urlHost = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  return `${scheme}://${urlHost}:${port}/`;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || !ALLOWED_PORTS.has(port))
    throw new Error("browser_proxy_port_denied");
}

async function resolveTarget(urlValue: string, resolveHost?: ResolveWebHost): Promise<Target> {
  const candidate = new URL(urlValue);
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:")
    throw new Error("browser_proxy_scheme_denied");
  if (candidate.username || candidate.password) throw new Error("browser_proxy_credentials_denied");
  const port = candidate.port ? Number(candidate.port) : candidate.protocol === "https:" ? 443 : 80;
  validatePort(port);
  let dnsAddresses: readonly string[] | undefined;
  const resolver: ResolveWebHost = async (hostname) => {
    dnsAddresses = await (resolveHost ?? systemResolveWebHost)(hostname);
    return dnsAddresses;
  };
  const url = await assertPublicWebUrl(candidate.href, resolver);
  const host = stripIpv6Brackets(url.hostname);
  const addresses = dnsAddresses ?? [host];
  if (!addresses.length) throw new Error("browser_proxy_unresolved");
  // assertPublicWebUrl has checked every address. Connect to one of those exact
  // literals so the OS does not resolve the original hostname a second time.
  return { url, address: addresses[0]!, port };
}

function parseConnectTarget(authority: string): { url: string; port: number } {
  if (!authority || /[\s/@?#]/u.test(authority))
    throw new Error("browser_proxy_invalid_connect_target");
  const hasExplicitPort = authority.startsWith("[")
    ? /^\[[0-9a-f:.]+\]:\d+$/iu.test(authority)
    : /^[^:]+:\d+$/u.test(authority);
  if (!hasExplicitPort) throw new Error("browser_proxy_invalid_connect_target");
  let parsed: URL;
  try {
    parsed = new URL(`https://${authority}/`);
  } catch {
    throw new Error("browser_proxy_invalid_connect_target");
  }
  const portMatch = authority.match(/:(\d+)$/u);
  const port = Number(portMatch?.[1]);
  validatePort(port);
  if (port !== 443) throw new Error("browser_proxy_port_denied");
  return { url: withPort("https", parsed.hostname, port), port };
}

function parseRequestHead(data: Buffer): { header: string; remainder: Buffer } | undefined {
  const end = data.indexOf("\r\n\r\n");
  if (end < 0) {
    if (data.length > MAX_HEADER_BYTES) throw new Error("browser_proxy_headers_too_large");
    return undefined;
  }
  if (end > MAX_HEADER_BYTES) throw new Error("browser_proxy_headers_too_large");
  return { header: data.subarray(0, end).toString("latin1"), remainder: data.subarray(end + 4) };
}

function parseHeaders(header: string): {
  requestLine: string;
  lines: string[];
  method: string;
  target: string;
  version: string;
} {
  const lines = header.split("\r\n");
  const match = lines.shift()?.match(/^(\S+)\s+(\S+)\s+(HTTP\/1\.[01])$/u);
  if (!match) throw new Error("browser_proxy_invalid_request");
  if (lines.some((line) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*:/u.test(line)))
    throw new Error("browser_proxy_invalid_headers");
  return {
    requestLine: `${match[1]} ${match[2]} ${match[3]}`,
    lines,
    method: match[1]!,
    target: match[2]!,
    version: match[3]!,
  };
}

function responseAndClose(client: Socket, status: number, reason: string): void {
  if (client.destroyed) return;
  client.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function tunnel(client: Socket, upstream: Duplex, initial?: Buffer): void {
  client.removeAllListeners("data");
  upstream.once("error", () => client.destroy());
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
  if (initial?.length) upstream.write(initial);
  client.resume();
}

/**
 * A local HTTP/CONNECT proxy for one browser session. It validates the target,
 * every DNS answer, and the destination port before opening an upstream socket.
 */
export class BrowserProxy {
  private server?: Server;
  private endpointValue?: string;
  private readonly clients = new Set<Socket>();
  private readonly connectTo: BrowserProxyConnector;

  constructor(private readonly options: BrowserProxyOptions) {
    this.connectTo =
      options.connectTo ??
      ((address, port) =>
        tcpConnect({
          host: address,
          port,
          ...(isIP(address) === 6 ? { family: 6 } : { family: 4 }),
        }));
  }

  async start(): Promise<string> {
    if (this.endpointValue) return this.endpointValue;
    if (
      !isIP(this.options.listenHost) ||
      ((this.options.listenHost === "0.0.0.0" || this.options.listenHost === "::") &&
        !this.options.allowWildcardListen)
    )
      throw new Error("browser_proxy_bind_address_required");
    const listenPort = this.options.listenPort ?? 0;
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65_535)
      throw new Error("browser_proxy_bind_port_invalid");
    if (!this.options.advertisedHost || /[\s/:?#]/u.test(this.options.advertisedHost))
      throw new Error("browser_proxy_advertise_address_required");
    const server = createTcpServer((client) => {
      this.clients.add(client);
      client.once("close", () => this.clients.delete(client));
      this.handleClient(client);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, this.options.listenHost, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("browser_proxy_start_failed");
    const advertisedHost =
      isIP(this.options.advertisedHost) === 6
        ? `[${this.options.advertisedHost}]`
        : this.options.advertisedHost;
    this.endpointValue = `http://${advertisedHost}:${address.port}`;
    return this.endpointValue;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpointValue = undefined;
    if (!server?.listening) return;
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private handleClient(client: Socket): void {
    let buffered = Buffer.alloc(0);
    let processing = false;
    client.on("error", () => undefined);
    client.on("data", (chunk: Buffer) => {
      if (processing) return;
      buffered = Buffer.concat([buffered, chunk]);
      let parsed: ReturnType<typeof parseRequestHead>;
      try {
        parsed = parseRequestHead(buffered);
      } catch {
        processing = true;
        responseAndClose(client, 431, "Request Header Fields Too Large");
        return;
      }
      if (!parsed) return;
      processing = true;
      client.pause();
      void this.forward(client, parsed.header, parsed.remainder);
    });
  }

  private async forward(client: Socket, header: string, remainder: Buffer): Promise<void> {
    try {
      const request = parseHeaders(header);
      if (request.method.toUpperCase() === "CONNECT") {
        const target = parseConnectTarget(request.target);
        const resolved = await resolveTarget(target.url, this.options.resolveHost);
        const upstream = this.connectTo(resolved.address, target.port);
        upstream.once("error", () => responseAndClose(client, 502, "Bad Gateway"));
        upstream.once("connect", () => {
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          tunnel(client, upstream, remainder);
        });
        return;
      }

      let targetUrl: URL;
      try {
        targetUrl = new URL(request.target);
      } catch {
        throw new Error("browser_proxy_absolute_url_required");
      }
      if (targetUrl.protocol !== "http:") throw new Error("browser_proxy_scheme_denied");
      const resolved = await resolveTarget(targetUrl.href, this.options.resolveHost);
      if (resolved.port !== 80) throw new Error("browser_proxy_port_denied");
      const upstream = this.connectTo(resolved.address, resolved.port);
      upstream.once("error", () => responseAndClose(client, 502, "Bad Gateway"));
      upstream.once("connect", () => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        const isUpgrade = request.lines.some((line) => /^upgrade\s*:/iu.test(line));
        const lines = request.lines.filter(
          (line) => !/^(?:host|proxy-connection|proxy-authorization|connection)\s*:/iu.test(line),
        );
        lines.push(`Host: ${resolved.url.host}`);
        lines.push(`Connection: ${isUpgrade ? "Upgrade" : "close"}`);
        if (isUpgrade) {
          const upgrade = request.lines.find((line) => /^upgrade\s*:/iu.test(line));
          if (upgrade) lines.push(upgrade);
        }
        const path = `${resolved.url.pathname}${resolved.url.search}` || "/";
        upstream.write(
          `${request.method} ${path} ${request.version}\r\n${lines.join("\r\n")}\r\n\r\n`,
        );
        tunnel(client, upstream, remainder);
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code.startsWith("web_target_") || code.startsWith("browser_proxy_")) {
        responseAndClose(client, code.includes("port_denied") ? 403 : 403, "Forbidden");
      } else {
        responseAndClose(client, 502, "Bad Gateway");
      }
    }
  }
}
