import { JevProvider, type JevCandidate, type JevProviderClient } from "./jev-provider.js";

export interface JevPlan {
  mode: "fast" | "complex";
  queryVariants: string[];
  timeRange?: string;
  jevUsed: boolean;
}

export interface JevPlannerOptions {
  provider?: JevProviderClient;
}

const MAX_QUERY_LENGTH = 500;
const MAX_VARIANTS = 3;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "about",
  "by",
  "for",
  "from",
  "how",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "请",
  "帮我",
  "一下",
  "怎么样",
  "什么",
  "如何",
  "有关",
  "关于",
  "的",
  "吗",
  "呢",
  "和",
  "与",
  "在",
]);

function clean(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s,，:：!?！？。]+|[\s,，:：!?！？。]+$/g, "")
    .trim();
}

function isComplex(query: string): boolean {
  const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    words.length >= 9 ||
    /\b(compare|versus|vs\.?|and|or|trade-?offs?|pros and cons)\b|对比|比较|以及|同时|优缺点/i.test(
      query,
    )
  );
}

function extractTimeRange(query: string): string | undefined {
  const match =
    /(?:the\s+)?(?:last|past|过去|近)\s*(\d+)\s*(hours?|days?|weeks?|months?|小时|天|周|月)/i.exec(
      query,
    );
  if (match) return `${match[1]} ${match[2]}`;
  if (
    /\b(today|yesterday|this week|last week|recently|latest|newest)\b|今天|昨天|本周|最近|近期/i.test(
      query,
    )
  ) {
    return "recent";
  }
  return undefined;
}

/** Proposes bounded, repeatable search variants without generating new facts or subjects. */
export function expandWebQuery(query: string): string[] {
  const original = clean(query.slice(0, MAX_QUERY_LENGTH));
  if (!original) return [];

  const candidates = [original];
  let compact = original
    .replace(/^(please\s+)?(find|search for|look up|tell me about|show me)\s+/i, "")
    .replace(/^(请)?(帮我)?(搜索|搜一下|查找|查一下|找一下)\s*/i, "")
    .replace(/\b(in|over|during) the (last|past) \d+ (hours?|days?|weeks?|months?)\b/gi, " ")
    .replace(/\b(last|past) \d+ (hours?|days?|weeks?|months?)\b/gi, " ")
    .replace(/(过去|近)\s*\d+\s*(小时|天|周|月)/g, " ");
  compact = clean(compact.replace(/[?？]+$/g, ""));
  if (compact && compact.toLocaleLowerCase() !== original.toLocaleLowerCase())
    candidates.push(compact);

  const keywords = compact.split(/\s+/u).filter((word) => {
    const normalized = word
      .toLocaleLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#.-]+$/gu, "");
    return normalized.length > 1 && !STOP_WORDS.has(normalized);
  });
  const keywordQuery = clean(keywords.join(" "));
  if (
    keywordQuery &&
    !candidates.some(
      (candidate) => candidate.toLocaleLowerCase() === keywordQuery.toLocaleLowerCase(),
    )
  ) {
    candidates.push(keywordQuery);
  }
  return candidates.slice(0, MAX_VARIANTS);
}

export class JevPlanner {
  private readonly provider: JevProviderClient;

  constructor(options: JevPlannerOptions = {}) {
    this.provider = options.provider ?? new JevProvider();
  }

  async plan(query: string): Promise<JevPlan> {
    const variants = expandWebQuery(query);
    if (!variants.length) return { mode: "fast", queryVariants: [], jevUsed: false };
    const timeRange = extractTimeRange(query);
    const timeHint = timeRange ? { timeRange } : {};
    if (!isComplex(query) || variants.length < 2) {
      return { mode: "fast", queryVariants: [variants[0]!], ...timeHint, jevUsed: false };
    }

    const judged = await this.provider.chooseQuery(query.slice(0, MAX_QUERY_LENGTH), variants);
    if (judged.status !== "ready" || judged.value < 0 || judged.value >= variants.length) {
      return { mode: "complex", queryVariants: [variants[0]!], ...timeHint, jevUsed: false };
    }
    const selected = variants[judged.value]!;
    const queryVariants = [
      variants[0]!,
      ...variants
        .slice(1)
        .filter((variant) => variant.toLocaleLowerCase() === selected.toLocaleLowerCase()),
      ...variants
        .slice(1)
        .filter((variant) => variant.toLocaleLowerCase() !== selected.toLocaleLowerCase()),
    ].slice(0, MAX_VARIANTS);
    return { mode: "complex", queryVariants, ...timeHint, jevUsed: true };
  }

  async rerank(
    query: string,
    candidates: readonly { url: string; title: string; highlights: readonly string[] }[],
  ): Promise<readonly { url: string; relevanceScore: number }[]> {
    if (candidates.length === 0) return [];
    const bounded = candidates.slice(0, 12);
    const judged = await this.provider.scoreCandidates(
      query.slice(0, MAX_QUERY_LENGTH),
      bounded as readonly JevCandidate[],
    );
    if (judged.status !== "ready" || judged.value.length !== bounded.length) {
      return candidates.map((candidate) => ({ url: candidate.url, relevanceScore: 0 }));
    }

    const ranked = bounded.map((candidate, index) => ({
      url: candidate.url,
      relevanceScore: judged.value[index]!,
      index,
    }));
    ranked.sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index);
    return [
      ...ranked.map(({ url, relevanceScore }) => ({ url, relevanceScore })),
      ...candidates
        .slice(bounded.length)
        .map((candidate) => ({ url: candidate.url, relevanceScore: 0 })),
    ];
  }
}
