import type { LearningProgressKind } from "./contracts.js";

export interface ClassifiedProgress {
  kind: LearningProgressKind;
  statement: string;
  confidence: number;
}

const secretPattern =
  /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]|\bbearer\s+[a-z0-9._~+/-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu;
const urlPattern = /(?:https?:\/\/|\bwww\.)\S+/iu;
const thirdPartyPattern =
  /\b(?:he|she|they|someone|my friend|my coworker|my colleague|my teammate|他|她|他们|朋友|同事)\s+(?:said|says|wants?|is learning|learned|想学|正在学|学会了)/iu;
const mentionedThirdPartyPattern =
  /\b(?:my|our)\s+(?:friend|coworker|colleague|teammate|child|partner)\b|\b[A-Z][a-z]{1,24}\s+(?:said|asked|wants? to learn|is learning|learned)\b|(?:朋友|同事|孩子|伴侣).{0,24}(?:说|问|想学|正在学|学会了)/u;

export function isSafeProgressText(text: string): boolean {
  return !(
    text.length > 1000 ||
    text.includes("```") ||
    text.includes("`") ||
    text.includes('"') ||
    /(?:^|\s)'[^']+'(?=\s|$)/u.test(text) ||
    text.split(/\r?\n/u).some((line) => /^\s*>/u.test(line)) ||
    /[“”]/u.test(text) ||
    secretPattern.test(text) ||
    urlPattern.test(text) ||
    thirdPartyPattern.test(text) ||
    mentionedThirdPartyPattern.test(text)
  );
}

const goalPatterns: readonly RegExp[] = [
  /^(?:i(?:'m| am) learning|i(?:'m| am) studying|i want to learn|i need to learn|i have learned|i learned|i(?:'m| am) practicing|i want to get better at)\s+(.+?)[.!?。！？]*$/iu,
  /^(?:我正在学习|我正在学|我在学习|我在学|我想学习|我想学|我需要学习|我需要学|我学会了|我正在练习|我想提高)\s*(.+?)[。！？.!?]*$/u,
];

function normalizeTopic(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!?。！？]+$/u, "")
    .trim();
}

export function classifyLearningProgress(text: string): ClassifiedProgress | null {
  const source = text.trim();
  if (!source || !isSafeProgressText(source)) return null;
  for (const pattern of goalPatterns) {
    const match = source.match(pattern);
    const topic = match?.[1] ? normalizeTopic(match[1]) : "";
    if (topic.length >= 2 && topic.length <= 180) {
      const completed = /^(?:i have learned|i learned|我学会了)/iu.test(source);
      return {
        kind: completed ? "milestone" : "goal",
        statement: topic,
        confidence: 0.85,
      };
    }
  }
  return null;
}

export function repeatedQuestionCue(text: string): string | null {
  const source = text.trim();
  if (!isSafeProgressText(source) || !/[?？]/u.test(source)) return null;
  const match = source.match(
    /^(?:how do i|how can i|how to|what is|what are|为什么|如何|怎么|什么是)\s*(.{4,120})[?？]*$/iu,
  );
  if (!match?.[1]) return null;
  return normalizeTopic(match[1]);
}
