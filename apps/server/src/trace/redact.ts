// apps/server/src/trace/redact.ts
// Redaction patterns adapted from upstream trajectory-panel (daemon/lib/redact.js).
//
// Invariant: Raw Trace stored on disk is ALWAYS unmodified authorized evidence.
// Redaction is applied ONLY when projecting records for public display or
// unprivileged export (e.g. redactSecrets: true).

import type { TraceEntry } from "./store.js";

// Telegram-style bot tokens (<digits>:<30+ url-safe chars>)
const TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;

// Common API keys and tokens: OpenAI, Anthropic, GitHub, AWS, Slack, Bearer, Cloudflare, etc.
const KEY_RE =
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[a-zA-Z0-9_]{22}_[a-zA-Z0-9_]{59}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|cfat_[A-Za-z0-9]{20,}|r2_[A-Za-z0-9]{20,}|vca_[A-Za-z0-9]{20,}|api[_-]?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,})\b/gi;

// Sensitive field names / keywords
const SECRET_WORD_RE = /\b(botToken|appSecret|clientSecret|apiSecret|accessToken)\b/gi;

// JWT structured token pattern
const JWT_RE = /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;

/** Redacts known secret tokens, keys, and keywords from a text string. */
export function redactText(text: string): string {
  if (!text || typeof text !== "string") return text;
  let out = text.replace(TOKEN_RE, "<redacted:token>");
  out = out.replace(JWT_RE, "<redacted:jwt>");
  out = out.replace(KEY_RE, "<redacted:key>");
  out = out.replace(SECRET_WORD_RE, (m) => `${m.slice(0, 3)}***`);
  return out;
}

/** Truncates text exceeding the specified limit, appending a truncation marker. */
export function truncate(text: string, limit: number, marker = "…[truncated]"): string {
  if (typeof text !== "string" || text.length <= limit) return text;
  return text.slice(0, limit) + marker;
}

/** Check if text contains an unredacted secret pattern. */
export function containsSecret(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  TOKEN_RE.lastIndex = 0;
  KEY_RE.lastIndex = 0;
  JWT_RE.lastIndex = 0;
  return TOKEN_RE.test(text) || KEY_RE.test(text) || JWT_RE.test(text);
}

/** Recursively redact string values inside arbitrary objects and arrays. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Returns a screened projection copy of a TraceEntry with secrets masked.
 * The original entry object is untouched.
 */
export function redactTraceEntry<T = unknown>(entry: TraceEntry<T>): TraceEntry<T> {
  return {
    ...entry,
    event: redactValue(entry.event) as T,
  };
}
