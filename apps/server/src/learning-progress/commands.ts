import { requireIdentifier } from "../identity/scope.js";
import type { LearningProgressCommand } from "./contracts.js";

const commandId = /^[a-f0-9-]{36}$/iu;

/** Parses only exact commands from a persisted user message. */
export function parseLearningProgressCommand(text: string): LearningProgressCommand | null {
  const input = text.trim();
  if (/^\/progress\s+list$/iu.test(input)) return { action: "list" };
  if (/^\/progress\s+capture$/iu.test(input)) return { action: "capture" };
  const remember = input.match(/^\/progress\s+(?:capture\s*\|\s*|remember\s+)(.{2,500})$/iu);
  if (remember) return { action: "capture", statement: remember[1].trim() };
  const correct = input.match(/^\/progress\s+correct\s+([a-f0-9-]{36})\s+\|\s*(.{2,500})$/iu);
  if (correct) {
    requireIdentifier(correct[1]);
    return { action: "correct", recordId: correct[1], statement: correct[2].trim() };
  }
  const change = input.match(/^\/progress\s+(delete|confirm)\s+([a-f0-9-]{36})$/iu);
  if (change && commandId.test(change[2])) {
    requireIdentifier(change[2]);
    return { action: change[1].toLowerCase() as "delete" | "confirm", recordId: change[2] };
  }
  return null;
}
