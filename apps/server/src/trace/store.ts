// apps/server/src/trace/store.ts
// RawTraceStore: append-only JSONL writer for decoded Codex events.
// Each event is written as one JSON line with seq + timestamp + provenance.
// Never overwrites or deletes existing lines.

import { mkdirSync, readFileSync, appendFileSync } from "node:fs";

export const TRACE_PROVENANCE = "codex-app-server";
export const TRACE_PROVENANCE_CLAUDECODE = "claude-code-cli";

export interface TraceEntry<T = unknown> {
  seq: number;
  ts: string;
  event: T;
  provenance: string;
}

export function getGlassboxBase(): string {
  const here = new URL(".", import.meta.url).pathname;
  const segments = here.split("/").filter(Boolean);
  const repoRoot = segments.slice(0, segments.lastIndexOf("apps"));
  // filter(Boolean) drops the leading slash from the split, which would turn
  // the absolute repo root into a cwd-relative path (traces then land under
  // apps/server/data/... when the server runs with cwd=apps/server).
  return `/${repoRoot.join("/")}/.glassbox`;
}

export function getTracePath(sessionId: string): string {
  return `${getGlassboxBase()}/sessions/${sessionId}/trace.jsonl`;
}

export class RawTraceStore {
  private ensureDir(sessionId: string): void {
    const dir = `${getGlassboxBase()}/sessions/${sessionId}`;
    mkdirSync(dir, { recursive: true });
  }

  private nextSeq(sessionId: string): number {
    const path = getTracePath(sessionId);
    try {
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      return lines.length + 1;
    } catch {
      return 1;
    }
  }

  append(sessionId: string, event: unknown, provenance: string = TRACE_PROVENANCE): void {
    this.ensureDir(sessionId);
    const seq = this.nextSeq(sessionId);
    const entry: TraceEntry<typeof event> = {
      seq,
      ts: new Date().toISOString(),
      event,
      provenance,
    };
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(getTracePath(sessionId), line, "utf-8");
  }
}
