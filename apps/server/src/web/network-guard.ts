import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

/** Adapted from HKUDS/OpenHarness network_guard.py at 9b2efd795c6aa09f88b0c257d269a9e518da6ae7. */
export class WebTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WebTargetError";
  }
}

export type ResolveWebHost = (hostname: string) => Promise<readonly string[]>;

const LOCAL_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal"];

export async function systemResolveWebHost(hostname: string): Promise<readonly string[]> {
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map((item) => item.address);
  } catch {
    throw new WebTargetError("web_target_unresolved");
  }
}

/** Resolve through authenticated HTTPS when local DNS returns synthetic proxy addresses. */
export async function dohResolveWebHost(hostname: string): Promise<readonly string[]> {
  const answers: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", type);
    const response = await fetch(endpoint, {
      headers: { accept: "application/dns-json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      throw new WebTargetError("web_target_unresolved");
    });
    if (!response.ok) throw new WebTargetError("web_target_unresolved");
    const payload: unknown = await response.json().catch(() => undefined);
    if (!payload || typeof payload !== "object" || !("Status" in payload) || payload.Status !== 0)
      throw new WebTargetError("web_target_unresolved");
    const records = "Answer" in payload && Array.isArray(payload.Answer) ? payload.Answer : [];
    for (const record of records) {
      if (!record || typeof record !== "object" || !("type" in record) || !("data" in record))
        continue;
      if (record.type !== (type === "A" ? 1 : 28) || typeof record.data !== "string") continue;
      if (!isIP(record.data)) throw new WebTargetError("web_target_invalid_address");
      answers.push(record.data);
    }
  }
  if (!answers.length) throw new WebTargetError("web_target_unresolved");
  return answers;
}

function assertPublicAddress(
  address: string,
  syntheticDnsCidrs: readonly string[],
  fromDns: boolean,
): void {
  if (!isIP(address)) throw new WebTargetError("web_target_invalid_address");
  const parsed = ipaddr.parse(address);
  // An IPv4 mapped address must not inherit the apparent safety of an IPv6 prefix.
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    assertPublicAddress(parsed.toIPv4Address().toString(), syntheticDnsCidrs, fromDns);
    return;
  }
  if (
    fromDns &&
    syntheticDnsCidrs.some((cidr) => {
      try {
        const range = ipaddr.parseCIDR(cidr);
        return parsed.kind() === range[0].kind() && parsed.match(range);
      } catch {
        throw new WebTargetError("web_target_invalid_synthetic_cidr");
      }
    })
  )
    return;
  if (parsed.range() !== "unicast") throw new WebTargetError("web_target_non_public");
}

/** Validate syntax, hostname and all DNS answers before handing a public URL to a provider. */
export async function assertPublicWebUrl(
  value: string,
  resolveHost: ResolveWebHost = systemResolveWebHost,
  syntheticDnsCidrs: readonly string[] = [],
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebTargetError("web_target_invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new WebTargetError("web_target_invalid_scheme");
  if (!url.hostname) throw new WebTargetError("web_target_invalid_url");
  if (url.username || url.password) throw new WebTargetError("web_target_credentials");
  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[|\]$/gu, "");
  if (
    LOCAL_HOSTS.has(hostname) ||
    LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    (!isIP(hostname) && !hostname.includes("."))
  )
    throw new WebTargetError("web_target_local_host");

  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0) throw new WebTargetError("web_target_unresolved");
  for (const address of addresses) assertPublicAddress(address, syntheticDnsCidrs, !isIP(hostname));
  return url;
}

/** A caller must invoke this for every Location header and browser navigation. */
export async function assertPublicWebRedirect(
  previousUrl: string,
  location: string,
  resolveHost: ResolveWebHost = systemResolveWebHost,
  syntheticDnsCidrs: readonly string[] = [],
): Promise<URL> {
  let next: URL;
  try {
    next = new URL(location, previousUrl);
  } catch {
    throw new WebTargetError("web_target_invalid_url");
  }
  return assertPublicWebUrl(next.href, resolveHost, syntheticDnsCidrs);
}
