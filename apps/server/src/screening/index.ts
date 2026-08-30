// apps/server/src/screening/index.ts
// Secret screening at the surfacing layer.
//
// Evidence rule: the Raw Trace store is NEVER modified. Screening transforms
// what derived state and the HTTP/WS APIs return, never what the trace store
// appends. .glassbox/ stays byte-identical on disk.
//
// PATTERNS is the single source of truth for rules — adding a pattern is one
// entry. Each entry declares a name, a test-only RegExp, and a redact(match)
// function that returns the replacement text.

// ---------------------------------------------------------------------------
// Data-driven pattern table
// ---------------------------------------------------------------------------

interface Pattern {
  name: string;
  regex: RegExp;
  redact: (match: string) => string;
}

const PATTERNS: Pattern[] = [
  // Structured auth formats — tested before env-secret (which is greedy) ----
  {
    name: "jwt",
    regex: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/,
    redact: () => "eyJ...[REDACTED:jwt]",
  },
  {
    name: "bearer-token",
    regex: /(?:Bearer|Authorization)\s+[a-zA-Z0-9_\-\.]{16,}/,
    redact: (m) => {
      const spaceIdx = m.search(/\s/);
      return `${m.slice(0, spaceIdx + 1)}...[REDACTED:bearer-token]`;
    },
  },

  // Developer / model-provider API keys -------------------------------------------
  {
    name: "openai-key",
    regex: /\bsk-[a-zA-Z0-9_-]{48,150}\b/,
    redact: (m) => `${m.slice(0, 7)}...[REDACTED:openai-key]`,
  },
  {
    name: "anthropic-key",
    regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/,
    redact: (m) => `${m.slice(0, 10)}...[REDACTED:anthropic-key]`,
  },
  // Provider-specific tokens -----------------------------------------------------
  {
    name: "github-token",
    regex: /ghp_[a-zA-Z0-9]{36}\b/,
    redact: (m) => `${m.slice(0, 8)}...[REDACTED:github-token]`,
  },
  {
    name: "github-pat",
    regex: /github_pat_[a-zA-Z0-9_]{22}_[a-zA-Z0-9_]{59}\b/,
    redact: (m) => `${m.slice(0, 14)}...[REDACTED:github-pat]`,
  },
  {
    name: "aws-key",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    redact: (m) => `${m.slice(0, 6)}...[REDACTED:aws-key]`,
  },
  {
    name: "slack-token",
    regex: /\bxox[a-zA-Z]-[a-zA-Z0-9]{10,}\b/,
    redact: (m) => `${m.slice(0, 8)}...[REDACTED:slack-token]`,
  },

  // Env-style KEY=VALUE pairs (after auth formats to avoid greedy preemption) ----
  {
    name: "env-secret",
    // Env-style KEY=VALUE (case-insensitive key names, ≥16-char value).
    // The 'i' flag enables case-insensitive matching.
    regex: /(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTH_TOKEN|ACCESS_KEY|CREDENTIAL)\s*[=:]\s*["']?[a-zA-Z0-9_\-]{16,}/gi,
    redact: (m) => {
      const sep = m.search(/[=:]/);
      return `${m.slice(0, sep + 1)}...[REDACTED:env-secret]`;
    },
  },

  // Sensitive-length strings (entropy-based noise filter) ------------------------
  {
    name: "long-base64",
    // Match ≥64 characters that could be base64-encoded data.
    // Requires mixed case (at least one upper AND one lower) so pure-lowercase
    // hex strings fall through to long-hex instead.
    regex: /(?=.*[A-Z])(?=.*[a-z])[A-Za-z0-9+/]{64,}={0,2}/,
    redact: (m) => `${m.slice(0, 8)}...[REDACTED:long-base64]`,
  },
  {
    name: "long-hex",
    regex: /\b[0-9a-fA-F]{64,}\b/,
    redact: (m) => `${m.slice(0, 8)}...[REDACTED:long-hex]`,
  },
];

// ---------------------------------------------------------------------------
// Screen Text — per-call entry point
// ---------------------------------------------------------------------------

/** Result of screening a string. */
export interface ScreenResult {
  /** Text with matches replaced. */
  text: string;
  /** Names of patterns that matched at least once (empty = clean). */
  hits: string[];
}

/**
 * Replace every secret match in `text` with a short prefix + tag so the
 * Inspector stays useful without leaking credentials.
 *
 * Idempotent: already-redacted text (containing [REDACTED:...]) is never
 * changed further.
 */
export function screenText(text: string): ScreenResult {
  const hits: string[] = [];
  let result = text;

  // Rescan loop: in each pass we test each pattern against the CURRENT
  // result text and apply all replacements, then repeat until nothing
  // matches. This lets earlier patterns release text for later ones.
  let dirty = true;
  while (dirty) {
    dirty = false;
    for (const p of PATTERNS) {
      // Test without 'g' flag so RegExp.test() doesn't inherit lastIndex state
      const testRe = new RegExp(p.regex.source, p.regex.flags.replace("g", ""));
      if (!testRe.test(result)) continue;

      if (!hits.includes(p.name)) {
        hits.push(p.name);
      }

      const replaceRe = new RegExp(p.regex.source, p.regex.flags);
      const before = result;
      result = result.replace(replaceRe, (fullMatch) => {
        if (fullMatch.includes("[REDACTED:")) return fullMatch;
        return p.redact(fullMatch);
      });
      if (result !== before) dirty = true;
    }
  }

  return { text: result, hits };
}

// ---------------------------------------------------------------------------
// Screen Value — deep recursive walk
// ---------------------------------------------------------------------------

/**
 * Recursively screen every string leaf in a JSON-like structure.
 *
 * Objects -> recurse into values.
 * Arrays  -> recurse into elements.
 * Primitives -> pass through unchanged.
 */
export function screenValue(value: unknown): unknown {
  if (typeof value === "string") {
    return screenText(value).text;
  }
  if (Array.isArray(value)) {
    return value.map(screenValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = screenValue(v);
    }
    return out;
  }
  return value;
}
