import {
  assertPublicWebRedirect,
  assertPublicWebUrl,
  systemResolveWebHost,
  type ResolveWebHost,
} from "../web/network-guard.js";

export const LORA_SITE_ROOT = "https://lora-sys.github.io/loraSys/";
export const MAX_REDIRECTS = 5;
export const MAX_DOCUMENT_BYTES = 2_000_000;

export interface KnowledgeHttpResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

export interface KnowledgeNetworkProvider {
  request(url: string, signal?: AbortSignal): Promise<KnowledgeHttpResponse>;
  resolveHost?: ResolveWebHost;
}

export class KnowledgeSyncError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "KnowledgeSyncError";
  }
}

/** Accept only canonical pages in the configured public site prefix. */
export function canonicalSiteUrl(value: string, base = LORA_SITE_ROOT): string | undefined {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return undefined;
  }
  const root = new URL(LORA_SITE_ROOT);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== root.hostname ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.pathname.startsWith(root.pathname)
  )
    return undefined;
  url.hash = "";
  url.search = "";
  return url.href;
}

function canonicalSiteRequestUrl(value: string): string | undefined {
  const siteUrl = canonicalSiteUrl(value);
  if (siteUrl) return siteUrl;
  let url: URL;
  try {
    url = new URL(value, LORA_SITE_ROOT);
  } catch {
    return undefined;
  }
  const root = new URL(LORA_SITE_ROOT);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== root.hostname ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/robots.txt" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined;
  return url.href;
}

export function createWebsiteKnowledgeNetworkProvider(
  input: {
    fetchImpl?: typeof fetch;
    resolveHost?: ResolveWebHost;
  } = {},
): KnowledgeNetworkProvider {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    resolveHost: input.resolveHost ?? systemResolveWebHost,
    async request(url, signal) {
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetchImpl(url, {
        headers: { accept: "text/html, application/xml, application/rss+xml, text/xml" },
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      let body = "";
      if (!response.body) {
        body = await response.text();
        if (new TextEncoder().encode(body).byteLength > MAX_DOCUMENT_BYTES)
          throw new KnowledgeSyncError("knowledge_document_too_large");
      } else {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_DOCUMENT_BYTES) {
              await reader.cancel();
              throw new KnowledgeSyncError("knowledge_document_too_large");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        body = new TextDecoder().decode(bytes);
      }
      return {
        status: response.status,
        headers: {
          location: response.headers.get("location") ?? undefined,
          "content-type": response.headers.get("content-type") ?? undefined,
        },
        body,
      };
    },
  };
}

export async function fetchCanonicalSiteDocument(
  provider: KnowledgeNetworkProvider,
  value: string,
  signal?: AbortSignal,
): Promise<{ url: string; response: KnowledgeHttpResponse }> {
  const resolveHost = provider.resolveHost ?? systemResolveWebHost;
  let next = canonicalSiteRequestUrl(value);
  if (!next) throw new KnowledgeSyncError("knowledge_url_not_allowed");
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let publicUrl: URL;
    try {
      publicUrl = await assertPublicWebUrl(next, resolveHost);
    } catch {
      throw new KnowledgeSyncError("knowledge_network_target_denied");
    }
    const response = await provider.request(publicUrl.href, signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location || redirects === MAX_REDIRECTS)
        throw new KnowledgeSyncError("knowledge_redirect_limit");
      let checked: URL;
      try {
        checked = await assertPublicWebRedirect(publicUrl.href, location, resolveHost);
      } catch {
        throw new KnowledgeSyncError("knowledge_network_target_denied");
      }
      next = canonicalSiteRequestUrl(checked.href) ?? "";
      if (!next) throw new KnowledgeSyncError("knowledge_redirect_not_allowed");
      continue;
    }
    return { url: publicUrl.href, response };
  }
  throw new KnowledgeSyncError("knowledge_redirect_limit");
}
