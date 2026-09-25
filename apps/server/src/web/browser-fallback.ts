import { BrowserBridge } from "./browser-bridge.js";
import type { BrowserSessionBinding } from "./browser-session.js";
import { assertPublicWebUrl, type ResolveWebHost } from "./network-guard.js";
import type { BrowserFallbackStatus, BrowserSearchFallback } from "./web-service.js";

const CAPTCHA =
  /captcha|challenge|verify (?:you are|you're) human|unusual traffic|too many requests|rate limit|sign in to continue/iu;
const SEARCH_URL = "https://www.bing.com/search";
const MAX_SEARCH_RESULTS = 10;

interface SnapshotLink {
  ref: string;
  title: string;
}

function snapshotRef(line: string): string | undefined {
  const match =
    /\[(?:ref=)?@?(e[1-9][0-9]{0,5})\]|\bref=@?(e[1-9][0-9]{0,5})\b|(@e[1-9][0-9]{0,5})\b/u.exec(
      line,
    );
  const ref = match?.[1] ?? match?.[2] ?? match?.[3];
  return ref ? (ref.startsWith("@") ? ref : `@${ref}`) : undefined;
}

function snapshotText(output: string): string {
  return output.slice(0, 20_000);
}

function snapshotContent(output: string): string {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const snapshot = (parsed as Record<string, unknown>).snapshot;
      if (typeof snapshot === "string") return snapshotText(snapshot);
    }
  } catch {
    /* Tests and alternate bridge ports may return plain snapshots. */
  }
  return snapshotText(output);
}

function blocked(output: string): boolean {
  return CAPTCHA.test(output);
}

function isSearchProviderHost(hostname: string): boolean {
  return ["bing.com", "duckduckgo.com"].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function isGenericSearchTitle(title: string, hostname: string): boolean {
  const normalized = title.trim().toLocaleLowerCase();
  return (
    normalized === hostname.toLocaleLowerCase() ||
    ["read more", "more", "here", "visit site"].includes(normalized)
  );
}

/** The target URL comes from a separate, bounded `get attr` action, never from page instructions. */
export function parseBrowserSearchSnapshot(snapshot: string, maxResults: number): SnapshotLink[] {
  snapshot = snapshotContent(snapshot);
  const lines = snapshot.split(/\r?\n/u);
  const hasMain = lines.some((line) => /^\s*-\s*main\b/iu.test(line));
  const links: SnapshotLink[] = [];
  const seen = new Set<string>();
  let inResults = !hasMain;
  for (const line of lines) {
    if (/^\s*-\s*main\b/iu.test(line)) {
      inResults = true;
      continue;
    }
    if (!inResults) continue;
    const title = /(?:\blink\s+|\[link\]\s*)"([^"]{3,300})"/iu.exec(line)?.[1];
    const ref = snapshotRef(line);
    if (!title || !ref || seen.has(ref)) continue;
    seen.add(ref);
    links.push({ title, ref });
    if (links.length >= Math.min(maxResults, MAX_SEARCH_RESULTS)) break;
  }
  return links;
}

function hrefFromOutput(value: string): string | undefined {
  const text = value.trim();
  if (/^https?:\/\//iu.test(text)) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") return parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      "value" in parsed &&
      typeof parsed.value === "string"
    )
      return parsed.value;
  } catch {
    /* The CLI may return plain text. */
  }
  return undefined;
}

function statusFromError(error: unknown): BrowserFallbackStatus {
  const message = error instanceof Error ? error.message : "";
  if (/browser_denied|capability_category_disabled/u.test(message)) return "fallback_denied";
  if (/browser_backend_unavailable|browser_executor|sandbox/u.test(message)) return "unavailable";
  if (/timeout|cancel/u.test(message)) return "unknown";
  return "failed";
}

/** A fixed public search flow using the same #23 browser session port as the protected Tool. */
export class GuardedBrowserFallback implements BrowserSearchFallback {
  constructor(
    private readonly options: {
      bridge?: BrowserBridge;
      binding: () => Promise<BrowserSessionBinding | undefined>;
      authorize: (
        binding: BrowserSessionBinding,
        capability: "browser.read" | "browser.interact",
      ) => Promise<boolean>;
      resolveHost?: ResolveWebHost;
      onActivated?: (binding: BrowserSessionBinding, cleanup: () => Promise<void>) => void;
    },
  ) {}

  private async preparedBinding(
    capabilities: readonly ("browser.read" | "browser.interact")[],
  ): Promise<BrowserSessionBinding | null> {
    const binding = await this.options.binding();
    if (!binding) return null;
    for (const capability of capabilities)
      if (!(await this.options.authorize(binding, capability))) return null;
    return { ...binding, purpose: "fallback" };
  }

  async search(query: string, maxResults: number): ReturnType<BrowserSearchFallback["search"]> {
    const binding = await this.preparedBinding(["browser.read"]);
    if (!binding) return { status: "fallback_denied", results: [] };
    const bridge = this.options.bridge;
    if (!bridge) return { status: "unavailable", results: [] };
    this.options.onActivated?.(binding, () => bridge.cleanup(binding));
    try {
      const searchUrl = new URL(SEARCH_URL);
      searchUrl.searchParams.set("q", query);
      await bridge.execute(binding, { type: "open", url: searchUrl.href });
      await bridge.execute(binding, {
        type: "wait",
        condition: "load",
        value: "domcontentloaded",
      });
      const snapshot = snapshotContent(
        (await bridge.execute(binding, { type: "snapshot", interactive: true, compact: true }))
          .output,
      );
      if (blocked(snapshot)) return { status: "blocked", results: [] };
      const found = parseBrowserSearchSnapshot(snapshot, Math.min(maxResults * 4, 20));
      const results: Array<{ url: string; title: string; highlights: readonly string[] }> = [];
      for (const link of found) {
        if (!(await this.options.authorize(binding, "browser.read")))
          return { status: "fallback_denied", results: [] };
        try {
          const href = hrefFromOutput(
            (
              await bridge.execute(binding, {
                type: "get",
                kind: "attr",
                ref: link.ref,
                name: "href",
              })
            ).output,
          );
          if (!href) continue;
          const external = new URL(href, SEARCH_URL);
          const redirected = external.hostname.endsWith("duckduckgo.com")
            ? external.searchParams.get("uddg")
            : null;
          const target = await assertPublicWebUrl(
            redirected ?? external.href,
            this.options.resolveHost,
          );
          if (isSearchProviderHost(target.hostname)) continue;
          const existing = results.findIndex((result) => result.url === target.href);
          if (existing >= 0) {
            if (!isGenericSearchTitle(link.title, target.hostname))
              results[existing] = { ...results[existing]!, title: link.title };
            continue;
          }
          if (results.length >= maxResults) continue;
          results.push({ url: target.href, title: link.title, highlights: [] });
        } catch {
          /* One malformed result does not erase valid results. */
        }
      }
      return { status: results.length ? "succeeded" : "blocked", results };
    } catch (error) {
      return { status: statusFromError(error), results: [] };
    } finally {
      await bridge.cleanup(binding).catch(() => undefined);
    }
  }

  async fetch(url: string): ReturnType<BrowserSearchFallback["fetch"]> {
    const binding = await this.preparedBinding(["browser.read"]);
    if (!binding) return { status: "fallback_denied" };
    const bridge = this.options.bridge;
    if (!bridge) return { status: "unavailable" };
    this.options.onActivated?.(binding, () => bridge.cleanup(binding));
    try {
      await bridge.execute(binding, { type: "open", url });
      const read = await bridge.execute(binding, { type: "read" });
      if (blocked(read.output)) return { status: "blocked" };
      const final = hrefFromOutput(
        (await bridge.execute(binding, { type: "get", kind: "url" })).output,
      );
      const title = (await bridge.execute(binding, { type: "get", kind: "title" })).output.trim();
      const text = snapshotText(read.output);
      if (!text) return { status: "blocked" };
      return {
        status: "succeeded",
        finalUrl: final,
        title: title || undefined,
        text,
        extractionMethod: "agent_browser_dom",
        truncated: read.truncated,
      };
    } catch (error) {
      return { status: statusFromError(error) };
    } finally {
      await bridge.cleanup(binding).catch(() => undefined);
    }
  }
}
