import type { WebProviderStatus } from "./contracts.js";

const JEV_ENDPOINT = "https://thejevai.com/v1/systemone";
const JEV_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BODY_CHARS = 256_000;
const MAX_BODY_BYTES = 512_000;
const MAX_QUESTIONS = 13;
const MAX_STATE_CHARS = 24_000;

export interface JevCandidate {
  url: string;
  title: string;
  highlights: readonly string[];
}

export interface JevProviderOptions {
  apiKey?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export type JevJudgment<T> =
  | { status: "ready"; value: T }
  | { status: Exclude<WebProviderStatus, "ready" | "partial">; value?: never };

export interface JevProviderClient {
  chooseQuery(query: string, variants: readonly string[]): Promise<JevJudgment<number>>;
  scoreCandidates(
    query: string,
    candidates: readonly JevCandidate[],
  ): Promise<JevJudgment<readonly number[]>>;
}

type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | {
      type: "noul";
      instructions: string;
      criteria: { true: string; false: string };
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mapFailure(response: Response): Exclude<WebProviderStatus, "ready" | "partial"> {
  if (response.status === 401 || response.status === 403) return "auth_missing";
  if (response.status === 402 || response.status === 429) return "quota_exhausted";
  return "failed";
}

function finiteProbability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

async function readBoundedBody(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export class JevProvider implements JevProviderClient {
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: JevProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.JEV_API_KEY;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), 15_000);
  }

  private async evaluate<T>(
    state: unknown,
    questions: Record<string, Question>,
    parse: (answers: Record<string, unknown>) => T | undefined,
  ): Promise<JevJudgment<T>> {
    if (!this.apiKey) return { status: "auth_missing" };
    if (Object.keys(questions).length === 0 || Object.keys(questions).length > MAX_QUESTIONS) {
      return { status: "failed" };
    }

    const serializedState = JSON.stringify(state);
    if (serializedState.length > MAX_STATE_CHARS) return { status: "failed" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ state, model: JEV_MODEL, questions }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) return { status: mapFailure(response) };
      const text = await readBoundedBody(response);
      if (text === undefined) return { status: "failed" };
      if (text.length > MAX_BODY_CHARS) return { status: "failed" };
      const payload = asRecord(JSON.parse(text));
      const answers =
        payload && "code" in payload
          ? payload.code === 0
            ? asRecord(asRecord(asRecord(payload.data)?.result)?.answers)
            : undefined
          : asRecord(payload?.answers);
      if (!answers) return { status: "failed" };
      const value = parse(answers);
      return value === undefined ? { status: "failed" } : { status: "ready", value };
    } catch {
      return { status: controller.signal.aborted ? "timeout" : "failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  chooseQuery(query: string, variants: readonly string[]): Promise<JevJudgment<number>> {
    if (variants.length < 2 || variants.length > 4) return Promise.resolve({ status: "failed" });
    const criteria = Object.fromEntries(variants.map((variant, index) => [`q${index}`, variant]));
    return this.evaluate(
      { query, variants },
      {
        query: {
          type: "choice",
          instructions: "Which query is the best concise search query for the user's request?",
          criteria,
        },
      },
      (answers) => {
        const answer = asRecord(answers.query);
        if (answer?.type !== "choice" || typeof answer.choice !== "string") return undefined;
        const match = /^q([0-3])$/.exec(answer.choice);
        const index = match ? Number(match[1]) : -1;
        return index >= 0 && index < variants.length ? index : undefined;
      },
    );
  }

  scoreCandidates(
    query: string,
    candidates: readonly JevCandidate[],
  ): Promise<JevJudgment<readonly number[]>> {
    const batch = candidates.slice(0, MAX_QUESTIONS);
    if (batch.length === 0) return Promise.resolve({ status: "ready", value: [] });
    const questions: Record<string, Question> = {};
    batch.forEach((_, index) => {
      questions[`r${index}`] = {
        type: "noul",
        instructions: `Is results[${index}] relevant to the user's search request?`,
        criteria: {
          true: "The result directly discusses the requested subject or answers the request.",
          false: "The result only shares words with the request or discusses a different subject.",
        },
      };
    });
    const state = {
      query,
      results: batch.map((candidate) => ({
        title: candidate.title.slice(0, 300),
        highlights: candidate.highlights.slice(0, 3).map((highlight) => highlight.slice(0, 800)),
      })),
    };
    return this.evaluate(state, questions, (answers) => {
      const scores = batch.map((_, index) => {
        const answer = asRecord(answers[`r${index}`]);
        return answer?.type === "noul" ? finiteProbability(answer.noul) : undefined;
      });
      return scores.some((score) => score !== undefined)
        ? scores.map((score) => score ?? 0)
        : undefined;
    });
  }
}
