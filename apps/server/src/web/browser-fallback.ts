import { BrowserBridge } from "./browser-bridge.js";
import type { BrowserSessionBinding } from "./browser-session.js";
import { DockerBrowserEnvironment } from "./docker-browser.js";
import { dohResolveWebHost } from "./network-guard.js";
import type { BrowserSearchFallback } from "./web-service.js";

const CAPTCHA =
  /captcha|challenge|verify (?:you are|you're) human|unusual traffic|bots use duckduckgo|http status: 429/iu;
const SEARCH_URL = "https://duckduckgo.com/?q=";

function pageTitle(output: string): string | undefined {
  return /^- Page Title: (.+)$/mu.exec(output)?.[1]?.trim();
}

/** Parse only explicit external result links in a CLI accessibility snapshot. */
export function parseBrowserSearchSnapshot(
  snapshot: string,
  query: string,
  maxResults: number,
): Array<{
  url: string;
  title: string;
  highlights: readonly string[];
}> {
  if (CAPTCHA.test(snapshot)) return [];
  const terms = (query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 8);
  const results: Array<{ url: string; title: string; highlights: readonly string[] }> = [];
  const seen = new Set<string>();
  const lines = snapshot.split(/\r?\n/u);
  for (let index = 0; index < lines.length - 1 && results.length < maxResults; index += 1) {
    const title = /^\s*- link "([^"]{3,300})" \[ref=[A-Za-z0-9_-]+\]/u.exec(lines[index]!)?.[1];
    const url = /^\s*- \/url: (https?:\/\/\S+)/u.exec(lines[index + 1]!)?.[1];
    if (!title || !url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.hostname.endsWith("duckduckgo.com") || seen.has(parsed.href)) continue;
    if (terms.length && !terms.some((term) => title.toLocaleLowerCase().includes(term))) continue;
    seen.add(parsed.href);
    results.push({ url: parsed.href, title, highlights: [] });
  }
  return results;
}

/** Uses a real browser only after Exa fails, and closes its isolated session on every path. */
export class GuardedBrowserFallback implements BrowserSearchFallback {
  constructor(
    private readonly options: {
      binding: () => BrowserSessionBinding | undefined;
      authorizeRead: (binding: BrowserSessionBinding) => Promise<boolean>;
    },
  ) {}

  private async visit<T>(
    url: string,
    read: (snapshot: string, opened: string) => T,
  ): Promise<T | null> {
    const binding = this.options.binding();
    if (!binding || !(await this.options.authorizeRead(binding))) return null;
    const sandbox = new DockerBrowserEnvironment();
    const bridge = new BrowserBridge({
      runner: sandbox.run,
      proxyFactory: () => sandbox,
      resolveHost: dohResolveWebHost,
      authorize: async (requested, capability) =>
        capability === "browser.read" &&
        requested.runId === binding.runId &&
        requested.principalId === binding.principalId &&
        requested.conversationId === binding.conversationId &&
        this.options.authorizeRead(requested),
    });
    try {
      const opened = await bridge.execute(binding, { type: "open", url });
      const snapshot = await bridge.execute(binding, { type: "snapshot" });
      return read(snapshot.output, opened.output);
    } catch {
      return null;
    } finally {
      await bridge.cleanup(binding).catch(() => sandbox.close());
    }
  }

  async search(query: string, maxResults: number) {
    return (
      (await this.visit(`${SEARCH_URL}${encodeURIComponent(query)}`, (snapshot) =>
        parseBrowserSearchSnapshot(snapshot, query, maxResults),
      )) ?? []
    );
  }

  async fetch(url: string) {
    return this.visit(url, (snapshot, opened) => {
      if (CAPTCHA.test(snapshot) || /^- HTTP status: (?:4|5)\d\d/mu.test(snapshot)) return null;
      const text = snapshot.slice(0, 20_000);
      return text
        ? { title: pageTitle(opened), text, contentType: "text/x-playwright-snapshot" }
        : null;
    });
  }
}
