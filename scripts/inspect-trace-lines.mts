/** Parse a read snapshot without treating an in-progress final JSONL write as corruption. */
export function parseTraceSnapshot<T>(content: string): {
  events: T[];
  hasIncompleteTail: boolean;
} {
  const lines = content.split("\n");
  const events: T[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as T);
    } catch (error) {
      if (index === lines.length - 1 && !content.endsWith("\n")) {
        return { events, hasIncompleteTail: true };
      }
      throw new Error(`Invalid trace JSONL line ${index + 1}`, { cause: error });
    }
  }
  return { events, hasIncompleteTail: false };
}

export function isWatchSnapshotReady<T>(snapshot: {
  events: T[];
  hasIncompleteTail: boolean;
}): boolean {
  return snapshot.events.length > 0 && !snapshot.hasIncompleteTail;
}
