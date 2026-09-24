import { createHash } from "node:crypto";
import type { ExaResponse } from "./exa-provider.js";
import { ExaMcpProvider } from "./exa-mcp-provider.js";
import { JevPlanner } from "./jev-planner.js";
import { assertPublicWebUrl, type ResolveWebHost } from "./network-guard.js";
import type { WebFetchResult, WebSearchResult, WebSearchResultItem } from "./contracts.js";

const MAX_RESULTS = 10;
const MAX_QUERY_CHARS = 500;
const MAX_HIGHLIGHTS = 3;
const MAX_HIGHLIGHT_CHARS = 400;
const MAX_FETCH_CHARS = 20_000;
const MAX_DOMAIN_FILTERS = 10;
const TIME_RANGE_MS = {
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  month: 30 * 24 * 60 * 60 * 1_000,
  year: 365 * 24 * 60 * 60 * 1_000,
} as const;
const TRACKING_PARAMETERS = /^(?:utm_[a-z_]+|fbclid|gclid|mc_cid|mc_eid)$/iu;
// Local proxy DNS may return this RFC 2544 range as a synthetic address. It is accepted
// only as a resolver answer for provider-mediated Exa calls; literal URLs remain forbidden.
const SYNTHETIC_PROXY_DNS_CIDRS = ["198.18.0.0/15"] as const;

export interface WebSearchInput extends Record<string, unknown> {
  query: string;
  maxResults?: number;
  timeRange?: "day" | "week" | "month" | "year";
  language?: string;
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
}

export interface WebFetchInput extends Record<string, unknown> {
  url: string;
  query?: string;
  maxChars?: number;
}

export interface WebProvider {
  search(input: { query: string; maxResults: number }): Promise<ExaResponse>;
  contents(url: string, query?: string): Promise<ExaResponse>;
}

export interface WebPlanner {
  plan(query: string): Promise<{
    mode: "fast" | "complex";
    queryVariants: readonly string[];
    timeRange?: string;
    jevUsed: boolean;
  }>;
  rerank(
    query: string,
    candidates: readonly { url: string; title: string; highlights: readonly string[] }[],
  ): Promise<readonly { url: string; relevanceScore: number }[]>;
}

export type BrowserFallbackStatus =
  | "succeeded"
  | "blocked"
  | "unavailable"
  | "fallback_denied"
  | "partial"
  | "failed"
  | "unknown";

export interface BrowserSearchFallback {
  search(
    query: string,
    maxResults: number,
  ): Promise<{
    status: BrowserFallbackStatus;
    results: readonly {
      url: string;
      title?: string;
      highlights: readonly string[];
      author?: string | null;
      publishedAt?: string | null;
    }[];
    partial?: boolean;
  }>;
  fetch(url: string): Promise<{
    status: BrowserFallbackStatus;
    finalUrl?: string;
    title?: string;
    text?: string;
    contentType?: string;
    extractionMethod?: string;
    author?: string | null;
    publishedAt?: string | null;
    partial?: boolean;
    truncated?: boolean;
  }>;
}

export interface WebServiceOptions {
  provider?: WebProvider;
  planner?: WebPlanner;
  browserFallback?: BrowserSearchFallback;
  resolveHost?: ResolveWebHost;
  syntheticDnsCidrs?: readonly string[];
  now?: () => Date;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error("invalid_web_limit");
  return Math.min(value, max);
}

function validatedQuery(query: string): string {
  if (typeof query !== "string") throw new Error("invalid_web_query");
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > MAX_QUERY_CHARS) throw new Error("invalid_web_query");
  return trimmed;
}

function normalizedDomains(value: readonly string[] | undefined, name: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DOMAIN_FILTERS)
    throw new Error(`invalid_web_${name}`);
  return value.map((domain) => {
    if (typeof domain !== "string" || domain.length > 253 || /[/:?#@*\s]/u.test(domain))
      throw new Error(`invalid_web_${name}`);
    let hostname: string;
    try {
      const parsed = new URL(`https://${domain}`);
      if (
        parsed.port ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        parsed.username ||
        parsed.password
      )
        throw new Error("invalid");
      hostname = parsed.hostname.toLocaleLowerCase().replace(/\.$/u, "");
    } catch {
      throw new Error(`invalid_web_${name}`);
    }
    if (
      !hostname.includes(".") ||
      hostname
        .split(".")
        .some(
          (label) =>
            !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
        )
    )
      throw new Error(`invalid_web_${name}`);
    return hostname;
  });
}

function matchesDomain(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.toLocaleLowerCase().replace(/\.$/u, "");
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isInTimeRange(
  publishedAt: string | null | undefined,
  range: keyof typeof TIME_RANGE_MS,
  nowMs: number,
): boolean {
  if (!publishedAt) return false;
  const timestamp = Date.parse(publishedAt);
  return (
    Number.isFinite(timestamp) && timestamp <= nowMs && timestamp >= nowMs - TIME_RANGE_MS[range]
  );
}

export function canonicalWebUrl(url: URL): string {
  const canonical = new URL(url.href);
  canonical.hash = "";
  for (const key of Array.from(canonical.searchParams.keys()))
    if (TRACKING_PARAMETERS.test(key)) canonical.searchParams.delete(key);
  if (canonical.pathname !== "/") canonical.pathname = canonical.pathname.replace(/\/+$/u, "");
  return canonical.href;
}

export function webSourceId(runId: string, canonicalUrl: string): string {
  return `web-${createHash("sha256").update(`${runId}\n${canonicalUrl}`).digest("hex").slice(0, 16)}`;
}

export class WebService {
  private readonly provider: WebProvider;
  private readonly planner: WebPlanner;
  private readonly now: () => Date;

  constructor(private readonly options: WebServiceOptions = {}) {
    this.provider =
      options.provider ??
      new ExaMcpProvider(
        undefined,
        options.resolveHost,
        options.syntheticDnsCidrs ?? SYNTHETIC_PROXY_DNS_CIDRS,
      );
    this.planner = options.planner ?? new JevPlanner();
    this.now = options.now ?? (() => new Date());
  }

  private publicUrl(value: string): Promise<URL> {
    return assertPublicWebUrl(
      value,
      this.options.resolveHost,
      this.options.syntheticDnsCidrs ?? SYNTHETIC_PROXY_DNS_CIDRS,
    );
  }

  async search(runId: string, input: WebSearchInput): Promise<WebSearchResult> {
    const query = validatedQuery(input.query);
    const limit = boundedInteger(input.maxResults, 5, MAX_RESULTS);
    if (input.language !== undefined) throw new Error("unsupported_web_language_filter");
    if (input.timeRange !== undefined && !Object.hasOwn(TIME_RANGE_MS, input.timeRange))
      throw new Error("invalid_web_time_range");
    const includeDomains = normalizedDomains(input.includeDomains, "include_domains");
    const excludeDomains = normalizedDomains(input.excludeDomains, "exclude_domains");
    const planned = await this.planner.plan(query);
    const variants = [...new Set(planned.queryVariants.filter(Boolean))].slice(0, 3);
    if (!variants.includes(query)) variants.unshift(query);
    const boundedVariants = variants.slice(0, 3);
    const providerResults = await Promise.allSettled(
      boundedVariants.map((variant) => this.provider.search({ query: variant, maxResults: limit })),
    );
    const successes = providerResults.flatMap((result) =>
      result.status === "fulfilled" && result.value.status === "ready" ? [result.value] : [],
    );
    const failures = providerResults.flatMap((result) =>
      result.status === "fulfilled" && result.value.status !== "ready"
        ? [result.value.status]
        : result.status === "rejected"
          ? ["failed" as const]
          : [],
    );
    const fallbackNeeded =
      this.options.browserFallback !== undefined &&
      successes.every((result) => result.results.length === 0);
    const browserOutcome = fallbackNeeded
      ? await this.options.browserFallback!.search(query, limit).catch(() => ({
          status: "failed" as const,
          results: [],
          partial: false,
        }))
      : undefined;
    const browserResults = browserOutcome?.results ?? [];
    const candidates: Array<{
      url: string;
      title: string;
      highlights: readonly string[];
      publishedAt?: string | null;
      author?: string | null;
      providerOrigin: string;
      retrievalMethod: "exa_search" | "browser_search";
    }> = successes
      .flatMap((result) => result.results)
      .map((result) => ({
        url: result.url ?? "",
        title: result.title ?? result.url ?? "",
        highlights: result.highlights ?? [],
        publishedAt: result.publishedDate,
        author: result.author,
        providerOrigin: "exa_mcp",
        retrievalMethod: "exa_search" as const,
      }));
    if (browserResults.length > 0)
      candidates.push(
        ...browserResults.map((result) => ({
          ...result,
          title: result.title ?? result.url,
          providerOrigin: "browser",
          retrievalMethod: "browser_search" as const,
        })),
      );
    const seen = new Map<string, WebSearchResultItem>();
    let discarded = 0;
    const nowMs = this.now().getTime();
    for (const candidate of candidates) {
      try {
        const url = await this.publicUrl(candidate.url);
        if (
          (includeDomains.length > 0 && !matchesDomain(url.hostname, includeDomains)) ||
          (excludeDomains.length > 0 && matchesDomain(url.hostname, excludeDomains)) ||
          (input.timeRange && !isInTimeRange(candidate.publishedAt, input.timeRange, nowMs))
        ) {
          discarded += 1;
          continue;
        }
        const canonicalUrl = canonicalWebUrl(url);
        if (seen.has(canonicalUrl)) {
          discarded += 1;
          continue;
        }
        const highlights = candidate.highlights
          .filter((value): value is string => typeof value === "string")
          .slice(0, MAX_HIGHLIGHTS)
          .map((value) => value.slice(0, MAX_HIGHLIGHT_CHARS));
        seen.set(canonicalUrl, {
          sourceId: webSourceId(runId, canonicalUrl),
          title: candidate.title.slice(0, 300),
          url: url.href,
          canonicalUrl,
          domain: url.hostname,
          retrievedAt: this.now().toISOString(),
          providerOrigins: [candidate.providerOrigin],
          retrievalMethod: candidate.retrievalMethod,
          ...(candidate.publishedAt !== undefined ? { publishedAt: candidate.publishedAt } : {}),
          ...(candidate.author !== undefined ? { author: candidate.author } : {}),
          highlights,
          rank: seen.size + 1,
        });
      } catch {
        discarded += 1;
      }
    }
    let ordered = [...seen.values()];
    if (planned.mode === "complex" && ordered.length > 1) {
      const scores = await this.planner.rerank(query, ordered).catch(() => []);
      const byUrl = new Map(scores.map((score) => [score.url, score.relevanceScore]));
      ordered = ordered
        .map((entry) => ({
          ...entry,
          ...(byUrl.has(entry.url) ? { relevanceScore: byUrl.get(entry.url) } : {}),
        }))
        .sort((a, b) => (b.relevanceScore ?? -1) - (a.relevanceScore ?? -1) || a.rank - b.rank);
    }
    const truncated = ordered.length > limit || discarded > 0;
    ordered = ordered.slice(0, limit).map((entry, index) => ({ ...entry, rank: index + 1 }));
    const partial =
      (failures.length > 0 && ordered.length > 0) ||
      browserOutcome?.status === "partial" ||
      browserOutcome?.partial === true;
    const providerStatus =
      successes.length > 0 ? (partial ? "partial" : "ready") : (failures[0] ?? "unknown");
    const fallbackStatus = browserOutcome?.status;
    const resultStatus =
      fallbackStatus ??
      (failures[0] === "failed" || failures[0] === "timeout"
        ? "failed"
        : failures[0] === "unknown"
          ? "unknown"
          : failures.length > 0
            ? "unavailable"
            : "unknown");
    return {
      query,
      status:
        ordered.length > 0
          ? partial
            ? "partial"
            : "succeeded"
          : fallbackNeeded && fallbackStatus && fallbackStatus !== "succeeded"
            ? fallbackStatus
            : successes.length > 0 || fallbackStatus === "succeeded"
              ? "succeeded"
              : resultStatus,
      providerStatus,
      partial,
      truncated,
      plan: {
        mode: fallbackNeeded ? "browser_fallback" : planned.mode,
        queryVariants: boundedVariants,
        jevUsed: planned.jevUsed,
        ...(planned.timeRange ? { timeRange: planned.timeRange } : {}),
      },
      candidateCount: candidates.length,
      discardedCount: discarded,
      results: ordered,
    };
  }

  async fetch(runId: string, input: WebFetchInput): Promise<WebFetchResult> {
    const url = await this.publicUrl(input.url);
    const maxChars = boundedInteger(input.maxChars, 8_000, MAX_FETCH_CHARS);
    const response = await this.provider.contents(url.href, input.query).catch(() => ({
      status: "failed" as const,
      results: [] as const,
    }));
    let raw =
      response.status === "ready"
        ? response.results.find((entry) => entry.url === url.href)
        : undefined;
    let method: "exa_contents" | "browser" = "exa_contents";
    let browserContent: Awaited<ReturnType<BrowserSearchFallback["fetch"]>> | undefined;
    if (!raw?.text && this.options.browserFallback) {
      browserContent = await this.options.browserFallback.fetch(url.href).catch(() => ({
        status: "failed" as const,
      }));
      method = "browser";
    }
    const fetchUrl = browserContent?.finalUrl ?? raw?.url ?? url.href;
    const validatedFinalUrl = await this.publicUrl(fetchUrl).catch(() => undefined);
    const resolvedUrl = validatedFinalUrl ?? url;
    const canonicalFetchUrl = canonicalWebUrl(resolvedUrl);
    const contentType = browserContent?.contentType;
    const textContent =
      !contentType || /^(?:text\/|application\/(?:json|xml|xhtml\+xml))/iu.test(contentType);
    const text = validatedFinalUrl && textContent ? (browserContent?.text ?? raw?.text ?? "") : "";
    const browserStatus = browserContent?.status;
    const succeeded = textContent && (Boolean(text) || browserStatus === "succeeded");
    const status: WebFetchResult["status"] = !validatedFinalUrl
      ? "failed"
      : browserStatus && browserStatus !== "succeeded"
        ? browserStatus
        : browserContent?.partial
          ? "partial"
          : succeeded
            ? "succeeded"
            : response.status === "ready"
              ? "unavailable"
              : response.status === "unknown"
                ? "unknown"
                : response.status === "failed" || response.status === "timeout"
                  ? "failed"
                  : "unavailable";
    return {
      sourceId: webSourceId(runId, canonicalFetchUrl),
      url: resolvedUrl.href,
      canonicalUrl: canonicalFetchUrl,
      domain: resolvedUrl.hostname,
      retrievedAt: this.now().toISOString(),
      providerOrigins: [method === "browser" ? "browser" : "exa_mcp"],
      retrievalMethod: method,
      status,
      providerStatus: response.status,
      ...((browserContent?.title ?? raw?.title)
        ? { title: browserContent?.title ?? raw?.title }
        : {}),
      ...(contentType ? { contentType } : {}),
      ...(browserContent?.extractionMethod
        ? { extractionMethod: browserContent.extractionMethod }
        : raw?.text
          ? { extractionMethod: "exa_contents" }
          : {}),
      ...(browserContent?.author !== undefined ? { author: browserContent.author } : {}),
      ...(browserContent?.publishedAt !== undefined
        ? { publishedAt: browserContent.publishedAt }
        : {}),
      text: text.slice(0, maxChars),
      partial: browserContent?.partial ?? false,
      truncated: browserContent?.truncated ?? text.length > maxChars,
    };
  }
}
