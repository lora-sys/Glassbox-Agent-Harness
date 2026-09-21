import { randomUUID } from "node:crypto";

export type LearningIdKind = "memory" | "candidate";

const uuidPattern =
  /^([0-9a-f]{8})-([0-9a-f]{4})-([1-5][0-9a-f]{3})-([89ab][0-9a-f]{3})-([0-9a-f]{12})$/iu;

/** Public governance handles must not look like Glassbox's internal UUIDs. */
export function createLearningId(kind: LearningIdKind): string {
  return `${kind}_${randomUUID().replaceAll("-", "")}`;
}

export function publicLearningId(kind: LearningIdKind, id: string): string {
  const match = uuidPattern.exec(id);
  return match ? `${kind}_legacy_${match.slice(1).join("").toLowerCase()}` : id;
}

export function internalLearningId(kind: LearningIdKind, id: string): string {
  const match = new RegExp(`^${kind}_legacy_([0-9a-f]{32})$`, "iu").exec(id);
  if (!match) return id;
  const value = match[1]!.toLowerCase();
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
