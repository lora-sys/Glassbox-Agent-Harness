export type WebProviderStatus =
  | "ready"
  | "auth_missing"
  | "rate_limited"
  | "quota_exhausted"
  | "timeout"
  | "failed"
  | "partial"
  | "unknown";

export type WebResultStatus =
  | "succeeded"
  | "partial"
  | "blocked"
  | "fallback_denied"
  | "unavailable"
  | "failed"
  | "unknown";

export interface WebSourceRef {
  sourceId: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  retrievedAt: string;
  providerOrigins: readonly string[];
  retrievalMethod:
    | "exa_search"
    | "exa_contents"
    | "browser_search"
    | "browser"
    | "agent_browser_dom"
    | "agent_browser_url_read";
  author?: string | null;
  publishedAt?: string | null;
}

export interface WebSearchResultItem extends WebSourceRef {
  title: string;
  publishedAt?: string | null;
  highlights: readonly string[];
  rank: number;
  /** Ranking signal only. It is never a factual confidence score. */
  relevanceScore?: number;
}

export interface WebSearchPlan {
  mode: "fast" | "complex" | "browser_fallback";
  queryVariants: readonly string[];
  timeRange?: string;
  jevUsed: boolean;
}

export interface WebSearchResult {
  query: string;
  status: WebResultStatus;
  providerStatus: WebProviderStatus;
  partial: boolean;
  truncated: boolean;
  plan: WebSearchPlan;
  candidateCount: number;
  discardedCount: number;
  results: readonly WebSearchResultItem[];
}

export interface WebFetchResult extends WebSourceRef {
  status: WebResultStatus;
  providerStatus: WebProviderStatus;
  title?: string;
  contentType?: string;
  extractionMethod?: string;
  text: string;
  partial: boolean;
  truncated: boolean;
}

export interface BrowserActionResult {
  status:
    | "succeeded"
    | "blocked"
    | "unavailable"
    | "fallback_denied"
    | "partial"
    | "failed"
    | "unknown";
  backend: "agent-browser";
  browserSessionId: string;
  action: string;
  output: string;
  truncated: boolean;
  observedAt: string;
  artifact?: {
    id: string;
    mimeType?: string;
    sizeBytes?: number;
  };
  postStateVerified?: boolean;
}
