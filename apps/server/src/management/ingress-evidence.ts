import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { securePrivatePath } from "../platform/private-path.js";

/** A payload-free reason a group message never became a Run. */
export type IngressDropReason =
  | "not_addressed"
  | "empty_message"
  | "not_ready"
  | "invalid_message"
  | "unsupported_message"
  | "ingress_overflow"
  | "acceptance_failed";

/** Everything the log can say about one group message: answered, or stopped with a reason. */
export type IngressEvidenceReason = "normalized" | IngressDropReason;

/** One line of the append-only ingress log. Deliberately carries no message text. */
export interface IngressEvidenceEntry {
  ts: string;
  channelId: string;
  groupId?: string;
  reason: IngressEvidenceReason;
}

export interface GroupIngressEvidenceCounts {
  serviceStartedAt: string;
  lastObservedAt: string | null;
  normalized: number;
  ignoredNotAddressed: number;
  ignoredEmptyMessage: number;
  /** Group messages that arrived while the socket was not ready and were dropped. */
  droppedNotReady: number;
  rejectedInvalidMessage: number;
  rejectedUnsupportedMessage: number;
  rejectedOverflow: number;
  acceptanceFailed: number;
}

const FIELD_BY_REASON: Record<
  IngressDropReason,
  keyof Omit<GroupIngressEvidenceCounts, "serviceStartedAt" | "lastObservedAt">
> = {
  not_addressed: "ignoredNotAddressed",
  empty_message: "ignoredEmptyMessage",
  not_ready: "droppedNotReady",
  invalid_message: "rejectedInvalidMessage",
  unsupported_message: "rejectedUnsupportedMessage",
  ingress_overflow: "rejectedOverflow",
  acceptance_failed: "acceptanceFailed",
};

const COUNT_CEILING = 1_000_000;
const EMPTY_COUNTS = (): GroupIngressEvidenceCounts => ({
  serviceStartedAt: "",
  lastObservedAt: null,
  normalized: 0,
  ignoredNotAddressed: 0,
  ignoredEmptyMessage: 0,
  droppedNotReady: 0,
  rejectedInvalidMessage: 0,
  rejectedUnsupportedMessage: 0,
  rejectedOverflow: 0,
  acceptanceFailed: 0,
});

const diagnosticKey = (channelId: string, groupId: string): string => `${channelId}:${groupId}`;

/**
 * Group ingress evidence that outlives the process.
 *
 * The counters answer one question: a group went quiet and the Owner wants to know whether
 * the Agent never saw the message or saw it and chose not to answer. Keeping them in memory
 * made that answer vanish on every restart — a service restarted to fix a debug problem is
 * exactly the service whose ingress evidence you then need. So each observation is appended
 * to an append-only log and the counts are a projection of it.
 */
export class IngressEvidenceLog {
  private readonly counts = new Map<string, GroupIngressEvidenceCounts>();
  private readonly channelDroppedNotReady = new Map<string, number>();

  private constructor(private readonly logPath: string) {}

  static open(dataDirectory: string): IngressEvidenceLog {
    const log = new IngressEvidenceLog(join(dataDirectory, "ingress-diagnostics.jsonl"));
    log.load();
    return log;
  }

  /**
   * Applies the platform ACL, which the create-time mode cannot express.
   *
   * The data directory is already locked down by the service launcher and files under it
   * inherit that, so this is defence in depth rather than the only wall: it tightens the file
   * itself, and so also repairs one written by an earlier process that never did this.
   */
  async secureFile(): Promise<void> {
    if (!existsSync(this.logPath)) return;
    await securePrivatePath(this.logPath, false);
  }

  /** Restores every group's counters, including the ones written by earlier processes. */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.logPath, "utf-8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let entry: IngressEvidenceEntry;
      try {
        entry = JSON.parse(line) as IngressEvidenceEntry;
      } catch {
        // One unreadable line must not cost the whole log: the rest is still evidence.
        continue;
      }
      this.apply(entry);
    }
  }

  private apply(entry: IngressEvidenceEntry): void {
    if (!entry?.channelId || !entry.reason || !entry.ts) return;
    if (entry.groupId === undefined) {
      if (entry.reason !== "not_ready") return;
      const current = this.channelDroppedNotReady.get(entry.channelId) ?? 0;
      this.channelDroppedNotReady.set(entry.channelId, Math.min(COUNT_CEILING, current + 1));
      return;
    }
    if (!entry.groupId) return;
    const key = diagnosticKey(entry.channelId, entry.groupId);
    const current = this.counts.get(key) ?? EMPTY_COUNTS();
    if (current.serviceStartedAt === "") current.serviceStartedAt = entry.ts;
    current.lastObservedAt = entry.ts;
    if (entry.reason === "normalized") {
      current.normalized = Math.min(COUNT_CEILING, current.normalized + 1);
      this.counts.set(key, current);
      return;
    }
    const field = FIELD_BY_REASON[entry.reason];
    if (field) current[field] = Math.min(COUNT_CEILING, current[field] + 1);
    this.counts.set(key, current);
  }

  /** Counts for one group; `fallbackStartedAt` anchors groups with no recorded evidence. */
  countsFor(
    channelId: string,
    groupId: string,
    fallbackStartedAt: string,
  ): GroupIngressEvidenceCounts {
    return (
      this.counts.get(diagnosticKey(channelId, groupId)) ?? {
        ...EMPTY_COUNTS(),
        serviceStartedAt: fallbackStartedAt,
      }
    );
  }

  /** The durable count of private messages dropped while this channel was not ready. */
  channelDroppedNotReadyFor(channelId: string): number | undefined {
    return this.channelDroppedNotReady.get(channelId);
  }

  /** Records one message the Agent answered. */
  recordNormalized(channelId: string, groupId: string, ts: string): void {
    this.apply({ ts, channelId, groupId, reason: "normalized" });
    this.append({ ts, channelId, groupId, reason: "normalized" });
  }

  /** Records one message that never became a Run, with the reason it stopped. */
  recordDropped(channelId: string, groupId: string, reason: IngressDropReason, ts: string): void {
    this.apply({ ts, channelId, groupId, reason });
    this.append({ ts, channelId, groupId, reason });
  }

  /** Records a private message dropped before ingress without inventing a group scope. */
  recordChannelDroppedNotReady(channelId: string, ts: string): void {
    const entry: IngressEvidenceEntry = { ts, channelId, reason: "not_ready" };
    this.apply(entry);
    this.append(entry);
  }

  private append(entry: IngressEvidenceEntry): void {
    let fd: number | null = null;
    try {
      mkdirSync(join(this.logPath, ".."), { recursive: true });
      fd = openSync(this.logPath, "a", 0o600);
      // The mode argument is masked by umask and is ignored entirely for a file that already
      // exists, so tighten both paths: evidence about who was ignored must be as private as
      // the trace it correlates with, including a log an earlier process left loose.
      chmodSync(this.logPath, 0o600);
      appendFileSync(fd, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Losing one evidence line is survivable; failing the connection over it is not.
      return;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}
