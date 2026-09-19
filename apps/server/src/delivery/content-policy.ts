import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { screenText } from "../screening/index.js";
import { renderQqPlainText } from "./presentation.js";

export interface DeliveryContentDecision {
  allowed: boolean;
  text?: string;
  reasons: string[];
  candidateSha256: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function createQqDeliveryPolicy(
  options: {
    forbiddenValues?: readonly string[] | (() => readonly string[]);
    protectedValues?: readonly string[] | (() => readonly string[]);
  } = {},
) {
  const patterns = [
    {
      name: "windows-absolute-path",
      regex: /\b[A-Za-z]:[\\/](?:[^\s<>:"|?*]+[\\/])*[^\s<>:"|?*]*/u,
    },
    { name: "windows-unc-path", regex: /\\\\[^\\\s]+\\[^\\\s]+(?:\\[^\\\s]+)*/u },
    { name: "posix-private-path", regex: /\/(?:Users|home|var|tmp|opt|srv)\/[\w./-]+/u },
    {
      name: "private-network-url",
      regex:
        /\bhttps?:\/\/(?:localhost|[^\s/:]+\.(?:localhost|local|internal)|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:\/[^\s]*)?/iu,
    },
    {
      name: "internal-uuid",
      regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    },
  ] as const;

  const inspect = (text: string): string[] => {
    const reasons = screenText(text).hits.map((hit) => `secret:${hit}`);
    for (const pattern of patterns) if (pattern.regex.test(text)) reasons.push(pattern.name);
    const inspectValues = (
      input: readonly string[] | (() => readonly string[]) | undefined,
      prefix: string,
      minimumLength: number,
    ) => {
      const values = typeof input === "function" ? input() : (input ?? []);
      for (const value of [...new Set(values.map((item) => item.trim()))].filter(
        (item) => item.length >= minimumLength,
      )) {
        if (new RegExp(escapeRegex(value), "iu").test(text))
          reasons.push(
            `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`,
          );
      }
    };
    inspectValues(options.forbiddenValues, "configured", 4);
    inspectValues(options.protectedValues, "protected", 1);
    return [...new Set(reasons)];
  };

  return {
    prepare(candidate: string): DeliveryContentDecision {
      const candidateSha256 = createHash("sha256").update(candidate).digest("hex");
      const initial = inspect(candidate);
      if (initial.length > 0) return { allowed: false, reasons: initial, candidateSha256 };
      const text = renderQqPlainText(candidate);
      if (!text) return { allowed: false, reasons: ["empty-rendered-output"], candidateSha256 };
      const rendered = inspect(text);
      return rendered.length > 0
        ? { allowed: false, reasons: rendered, candidateSha256 }
        : { allowed: true, text, reasons: [], candidateSha256 };
    },
  };
}

export function hostDeliveryForbiddenValues(input: {
  dataDirectory: string;
  kitPath?: string;
  cwd?: string;
  modelValues?: readonly string[];
}): string[] {
  const paths = [input.dataDirectory, input.kitPath, input.cwd]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => {
      const absolute = resolve(value);
      const name = basename(absolute);
      return [absolute, ...(name.length >= 8 && /[-_.]/u.test(name) ? [name] : [])];
    });
  return [...paths, ...(input.modelValues ?? [])];
}
