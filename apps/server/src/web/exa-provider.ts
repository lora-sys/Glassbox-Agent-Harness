import { assertPublicWebUrl, type ResolveWebHost } from "./network-guard.js";
import type { WebProviderStatus } from "./contracts.js";

/** Exa API surface reviewed against https://exa.ai/docs/reference/search and /get-contents on 2026-09-23. */
const EXA_BASE = "https://api.exa.ai";
const EXA_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_BODY_CHARS = 1_000_000;

export interface ExaRawResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  highlights?: string[];
  text?: string;
  score?: number;
}

export type ExaResponse =
  | { status: "ready"; results: readonly ExaRawResult[]; requestId?: string }
  | { status: Exclude<WebProviderStatus, "ready" | "partial">; results: readonly [] };

export interface ExaProviderOptions {
  apiKey?: string;
  fetcher?: typeof fetch;
  resolveHost?: ResolveWebHost;
  timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readResults(value: unknown): readonly ExaRawResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const row = record(item);
    if (!row || typeof row.url !== "string") return [];
    return [
      {
        ...(typeof row.title === "string" ? { title: row.title } : {}),
        url: row.url,
        ...(typeof row.publishedDate === "string" ? { publishedDate: row.publishedDate } : {}),
        ...(Array.isArray(row.highlights)
          ? {
              highlights: row.highlights.filter(
                (highlight): highlight is string => typeof highlight === "string",
              ),
            }
          : {}),
        ...(typeof row.text === "string" ? { text: row.text } : {}),
        ...(typeof row.score === "number" ? { score: row.score } : {}),
      },
    ];
  });
}

export class ExaProvider {
  constructor(private readonly options: ExaProviderOptions) {}

  private async request(
    path: "/search" | "/contents",
    body: Record<string, unknown>,
  ): Promise<ExaResponse> {
    if (!this.options.apiKey) return { status: "auth_missing", results: [] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? EXA_TIMEOUT_MS);
    try {
      const response = await (this.options.fetcher ?? fetch)(`${EXA_BASE}${path}`, {
        method: "POST",
        headers: { "x-api-key": this.options.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403)
        return { status: "auth_missing", results: [] };
      if (response.status === 402 || response.status === 429)
        return { status: "quota_exhausted", results: [] };
      if (!response.ok) return { status: "failed", results: [] };
      const text = await response.text();
      if (text.length > MAX_PROVIDER_BODY_CHARS) return { status: "failed", results: [] };
      const parsed = record(JSON.parse(text));
      const results = readResults(parsed?.results);
      if (!results) return { status: "failed", results: [] };
      return {
        status: "ready",
        results,
        ...(typeof parsed?.requestId === "string" ? { requestId: parsed.requestId } : {}),
      };
    } catch {
      return { status: controller.signal.aborted ? "timeout" : "failed", results: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  search(input: {
    query: string;
    maxResults: number;
    includeDomains?: readonly string[];
    excludeDomains?: readonly string[];
    startPublishedDate?: string;
  }): Promise<ExaResponse> {
    return this.request("/search", {
      query: input.query,
      numResults: input.maxResults,
      type: "auto",
      contents: { highlights: { maxCharacters: 800 }, text: false },
      ...(input.includeDomains ? { includeDomains: input.includeDomains } : {}),
      ...(input.excludeDomains ? { excludeDomains: input.excludeDomains } : {}),
      ...(input.startPublishedDate ? { startPublishedDate: input.startPublishedDate } : {}),
    });
  }

  async contents(url: string, query?: string): Promise<ExaResponse> {
    const target = await assertPublicWebUrl(url, this.options.resolveHost);
    return this.request("/contents", {
      urls: [target.href],
      text: { maxCharacters: 20_000 },
      ...(query ? { highlights: { query, maxCharacters: 1_200 } } : {}),
    });
  }
}
