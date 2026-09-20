import { randomUUID } from "node:crypto";
import type {
  GlassboxMemoryScope,
  LearningOperationContext,
  MemoryExtractor,
  MemorySubject,
} from "./contracts.js";
import type { LearningStore } from "./store.js";

/** LangMem-style boundary: existing memories participate in extraction, while
 * every model decision remains a reviewable candidate until explicit promotion. */
export class MemoryConsolidator {
  constructor(
    private readonly store: LearningStore,
    private readonly extractor: MemoryExtractor,
  ) {}

  async consolidate(input: {
    context: LearningOperationContext;
    subject: MemorySubject;
    scope: GlassboxMemoryScope;
    messages: readonly { role: string; text: string; ref: string }[];
  }) {
    const existing = await this.store.listMemories(input.context, { scope: input.scope });
    const decisions = await this.extractor.extract({ messages: input.messages, existing });
    const candidates = [];
    for (const decision of decisions) {
      const evidence = input.messages.map((message) => ({
        evidenceId: randomUUID(),
        kind: "chat_message" as const,
        ref: message.ref,
        capturedAt: new Date().toISOString(),
        trustLevel: "low" as const,
        metadata: { role: message.role, untrustedInput: true },
      }));
      candidates.push(
        await this.store.createCandidate(input.context, {
          candidateKind:
            decision.action === "update" || decision.action === "retire" ? "correction" : "derived",
          subject: input.subject,
          scope: input.scope,
          proposedType: decision.type,
          statement: decision.statement,
          content: decision.content ?? { statement: decision.statement },
          source: {
            kind: "chat",
            ref: input.messages[0]?.ref ?? `run:${input.context.runId ?? "unknown"}`,
          },
          sourceEvidence: evidence,
          confidence: decision.confidence ?? 0.5,
          sensitivity: "confidential",
          mergeHint: {
            strategy: "manual_review_required",
            ...(decision.existingMemoryId ? { ifMatchMemoryId: decision.existingMemoryId } : {}),
          },
          extensions: {
            "glassbox:extractor_action": decision.action,
            "glassbox:model_inference": true,
          },
        }),
      );
    }
    return candidates;
  }
}
