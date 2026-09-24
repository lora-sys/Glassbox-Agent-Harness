import { BrowserBridge } from "./browser-bridge.js";
import type { BrowserSessionBinding } from "./browser-session.js";
import { assertPublicWebUrl, type ResolveWebHost } from "./network-guard.js";
import type { BrowserFallbackStatus, BrowserSearchFallback } from "./web-service.js";

const CAPTCHA =
  /captcha|challenge|verify (?:you are|you're) human|unusual traffic|too many requests|rate limit|sign in to continue/iu;
const SEARCH_URL = "https://duckduckgo.com/";
const MAX_SEARCH_RESULTS = 10;

interface SnapshotLink {
  ref: string;
  title: string;
}

function snapshotText(output: string): string {
  return output.slice(0, 20_000);
}

function blocked(output: string): boolean {
  return CAPTCHA.test(output);
}

/** The target URL comes from a separate, bounded `get attr` action, never from page instructions. */
export function parseBrowserSearchSnapshot(snapshot: string, maxResults: number): SnapshotLink[] {
  const links: SnapshotLink[] = [];
  const seen = new Set<string>();
  for (const line of snapshot.split(/\r?\n/u)) {
    const match = /\blink\s+"([^"]{3,300})"[^\n]*?(?:\[ref=)?(@e[1-9][0-9]{0,5})\]?/iu.exec(line);
    if (!match || seen.has(match[2]!)) continue;
    seen.add(match[2]!);
    links.push({ title: match[1]!, ref: match[2]! });
    if (links.length >= Math.min(maxResults, MAX_SEARCH_RESULTS)) break;
  }
  return links;
}

function searchInputRef(snapshot: string): string | undefined {
  for (const line of snapshot.split(/\r?\n/u)) {
    if (!/\b(?:searchbox|textbox|combobox)\b/iu.test(line)) continue;
    const ref = /@e[1-9][0-9]{0,5}\b/u.exec(line)?.[0];
    if (ref) return ref;
  }
  return undefined;
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
    const binding = await this.preparedBinding(["browser.read", "browser.interact"]);
    if (!binding) return { status: "fallback_denied", results: [] };
    const bridge = this.options.bridge;
    if (!bridge) return { status: "unavailable", results: [] };
    this.options.onActivated?.(binding, () => bridge.cleanup(binding));
    try {
      await bridge.execute(binding, { type: "open", url: SEARCH_URL });
      const first = snapshotText(
        (await bridge.execute(binding, { type: "snapshot", interactive: true })).output,
      );
      if (blocked(first)) return { status: "blocked", results: [] };
      const input = searchInputRef(first);
      if (!input) return { status: "blocked", results: [] };
      if (!(await this.options.authorize(binding, "browser.interact")))
        return { status: "fallback_denied", results: [] };
      await bridge.execute(binding, { type: "fill", ref: input, text: query });
      if (!(await this.options.authorize(binding, "browser.interact")))
        return { status: "fallback_denied", results: [] };
      await bridge.execute(binding, { type: "press", key: "Enter" });
      const snapshot = snapshotText(
        (await bridge.execute(binding, { type: "snapshot", interactive: true })).output,
      );
      if (blocked(snapshot)) return { status: "blocked", results: [] };
      const found = parseBrowserSearchSnapshot(snapshot, Math.min(maxResults * 2, 20));
      const results: Array<{ url: string; title: string; highlights: readonly string[] }> = [];
      for (const link of found) {
        if (results.length >= maxResults) break;
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
          if (target.hostname.endsWith("duckduckgo.com")) continue;
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
