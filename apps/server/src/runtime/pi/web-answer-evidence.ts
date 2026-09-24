import { WEB_FETCH_TOOL } from "./web-tools.js";
import { officialSourceVerificationRequested } from "./required-evidence.js";

export interface WebAnswerToolCall {
  name: string;
  input: Record<string, unknown>;
  failed?: boolean;
}

export type WebAnswerEvidenceFailure =
  | { reason: "source_not_read"; urls: readonly string[]; verifiedUrls: readonly string[] }
  | { reason: "unqualified_latest_claim"; urls: readonly string[] };

function normalizedUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.href;
  } catch {
    return undefined;
  }
}

function answerUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>\])】）），。！？；：、]+/giu)]
    .map(([value]) => value.replace(/[.,!?;:，。！？；：]+$/u, ""))
    .map(normalizedUrl)
    .filter((value): value is string => value !== undefined);
}

function fetchedUrls(calls: readonly WebAnswerToolCall[]): Set<string> {
  return new Set(
    calls.flatMap((call) => {
      if (call.name !== WEB_FETCH_TOOL || call.failed !== false) return [];
      return typeof call.input.url === "string"
        ? [normalizedUrl(call.input.url)].filter(Boolean)
        : [];
    }) as string[],
  );
}

const UNQUALIFIED_LATEST_CLAIM =
  /(?:最新(?:文章|博文|一篇|版本)(?:是|为|[:：]|\s*[（(])|截至[^。！？!?\n]{0,48}最新(?:文章|博文|一篇)?(?:是|为|[:：]))/iu;

/**
 * Checks only explicit official-source verification requests. Search candidates are not
 * citations: every URL in the answer must have a successful Fetch call. A bounded result also
 * cannot support an unqualified "latest article" claim.
 */
export function webAnswerEvidenceFailure(input: {
  request: string;
  answer: string;
  toolCalls: readonly WebAnswerToolCall[];
}): WebAnswerEvidenceFailure | undefined {
  if (!officialSourceVerificationRequested(input.request)) return undefined;

  const fetched = fetchedUrls(input.toolCalls);
  const urls = [...new Set(answerUrls(input.answer))];
  const unread = urls.filter((url) => !fetched.has(url));
  if (unread.length > 0)
    return { reason: "source_not_read", urls: unread, verifiedUrls: [...fetched] };

  if (
    /(?:最新|最近|latest|most recent)/iu.test(input.request) &&
    UNQUALIFIED_LATEST_CLAIM.test(input.answer)
  )
    return { reason: "unqualified_latest_claim", urls: [...fetched] };

  return undefined;
}

export function safeWebEvidenceReply(failure: WebAnswerEvidenceFailure): string {
  if (failure.reason === "unqualified_latest_claim")
    return [
      "本次搜索范围有限，无法据此判断绝对最新。以下是本次已直接读取的页面：",
      ...failure.urls,
    ].join("\n");
  return [
    "回答中有页面没有直接读取，因此不能确认其内容。以下是本次已直接读取的页面：",
    ...failure.verifiedUrls,
  ].join("\n");
}
