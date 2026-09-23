export type WebProviderStatus =
  | "ready"
  | "auth_missing"
  | "quota_exhausted"
  | "timeout"
  | "failed"
  | "partial"
  | "unknown";

export type WebResultStatus = "succeeded" | "partial" | "unavailable" | "failed";

export interface WebSourceRef {
  sourceId: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  retrievedAt: string;
  providerOrigins: readonly string[];
  retrievalMethod: "exa_search" | "exa_contents" | "browser_search" | "browser";
}

export interface WebSearchResultItem extends WebSourceRef {
  title: string;
  publishedAt?: string;
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
  text: string;
  partial: boolean;
  truncated: boolean;
}

export interface BrowserActionResult {
  status: "succeeded";
  browserSessionId: string;
  action: string;
  output: string;
  truncated: boolean;
  observedAt: string;
}
