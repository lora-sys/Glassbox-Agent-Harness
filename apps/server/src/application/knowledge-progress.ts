import { randomUUID } from "node:crypto";
import { AccessDeniedError } from "../auth/service.js";
import { scopeKey } from "../identity/scope.js";
import type { DomainStore } from "./domain-store.js";
import type { ExecutionInput, ExecutionResult } from "../execution/run-service/types.js";
import {
  WEBSITE_KNOWLEDGE_RESOURCE,
  WEBSITE_KNOWLEDGE_READ_ACTION,
  type WebsiteKnowledgeHit,
} from "../knowledge/index.js";
import type { LearningProgressRecord } from "../learning-progress/contracts.js";

function operation(input: ExecutionInput) {
  return { caller: input.caller, runId: input.run.id, conversationId: input.conversation.id };
}

/** Application coordinator. Text never supplies identity, source scope or synchronization URL. */
export class KnowledgeProgressContext {
  constructor(
    private readonly store: DomainStore,
    private readonly evidence: (
      input: ExecutionInput,
      record: Record<string, unknown>,
    ) => Promise<void>,
  ) {}

  private async persistedText(input: ExecutionInput): Promise<string | undefined> {
    if (input.executionMode !== undefined || input.run.source !== "external") return undefined;
    const caller = await this.store.identities.resolve(input.caller.scope);
    if (caller?.principalId !== input.caller.principalId) return undefined;
    return this.store.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: `SELECT m.text,r.principal_id,r.scope_json,r.conversation_id,r.source
          FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=?`,
        args: [input.run.id],
      });
      const row = rows.rows[0];
      if (
        !row ||
        row.principal_id !== input.caller.principalId ||
        row.conversation_id !== input.conversation.id ||
        row.source !== "external"
      )
        return undefined;
      try {
        if (
          typeof row.scope_json !== "string" ||
          scopeKey(JSON.parse(row.scope_json)) !== scopeKey(input.caller.scope)
        )
          return undefined;
      } catch {
        return undefined;
      }
      return typeof row.text === "string" ? row.text : undefined;
    });
  }

  async provisionArticles(input: ExecutionInput): Promise<void> {
    const context = operation(input);
    const read = await this.store.authorization.check({
      ...context,
      resourceId: WEBSITE_KNOWLEDGE_RESOURCE,
      action: WEBSITE_KNOWLEDGE_READ_ACTION,
    });
    const delivery = await this.store.authorization.check({
      ...context,
      resourceId: WEBSITE_KNOWLEDGE_RESOURCE,
      action: "delivery:send",
    });
    if (read.decision !== "ALLOW" || delivery.decision !== "ALLOW") return;
    for (const article of await this.store.knowledge.currentArticleResources()) {
      for (const action of [WEBSITE_KNOWLEDGE_READ_ACTION, "delivery:send"]) {
        await this.store.authorization.grantInitial({
          principalId: input.caller.principalId,
          scope: input.caller.scope,
          resourceId: article.resourceId,
          action,
          effect: "allow",
        });
      }
    }
  }

  async command(input: ExecutionInput): Promise<ExecutionResult | undefined> {
    if (!/^\/(?:knowledge|progress)\b/iu.test(input.text.trim())) return undefined;
    const text = (await this.persistedText(input))?.trim();
    if (!text || text !== input.text.trim())
      return {
        status: "failed",
        failureCode: "gate_refused",
        runtimeAttempted: false,
        text: "当前消息的身份或来源无法确认，未执行。",
      };
    try {
      if (/^\/progress\b/iu.test(text)) {
        const result = await this.store.progress.executeCommandFromCurrentRun(operation(input));
        if (!result)
          return {
            status: "succeeded",
            runtimeAttempted: false,
            text: "使用 /progress list 查看进度，/progress remember 加学习目标记录进度，/progress confirm 或 delete 加记录 ID 操作。更正使用 /progress correct 记录ID | 新内容。",
          };
        const records = "records" in result ? result.records : result.record ? [result.record] : [];
        await this.evidence(input, {
          type: "learning_progress_action",
          action: result.action,
          recordIds: records.map((record) => record.id),
        });
        const reply =
          result.action === "delete"
            ? "已删除指定学习进度。"
            : result.action === "confirm"
              ? "已确认指定学习进度。"
              : result.action === "correct"
                ? "已更正指定学习进度。"
                : result.action === "capture"
                  ? "已处理学习进度记录请求。"
                  : "当前可用的学习进度如下。";
        return {
          status: "succeeded",
          runtimeAttempted: false,
          text: [
            reply,
            ...records.map((record) => `${record.id} ${record.state} ${record.statement}`),
            ...("truncated" in result && result.truncated
              ? ["结果超过单次查看上限，当前只展示部分记录。"]
              : []),
          ].join("\n"),
        };
      }
      const context = operation(input);
      if (/^\/knowledge\s+(?:sync|enable|disable)$/iu.test(text)) {
        if (
          input.caller.scope.chatType !== "private" ||
          !(await this.store.identities.isOwner(input.caller.principalId))
        )
          throw new Error("owner_private_required");
        if (/disable$/iu.test(text)) {
          await this.store.knowledge.setSyncEnabled(context, false);
          return {
            status: "succeeded",
            runtimeAttempted: false,
            text: "已关闭网站知识库自动同步。",
          };
        }
        if (/enable$/iu.test(text)) await this.store.knowledge.setSyncEnabled(context, true);
        const result = await this.store.knowledge.syncSite(context, input.signal);
        await this.evidence(input, { type: "website_knowledge_sync", ...result });
        return {
          status: "succeeded",
          runtimeAttempted: false,
          text: `网站知识库已同步 ${result.articleCount} 篇文章。新增 ${result.inserted} 篇，更新 ${result.updated} 篇，下架 ${result.removed} 篇。`,
        };
      }
      const interests = /^\/knowledge\s+interests\s+(.{2,200})$/iu.exec(text);
      if (interests) {
        if (
          input.caller.scope.chatType !== "private" ||
          !(await this.store.identities.isOwner(input.caller.principalId))
        )
          throw new Error("owner_private_required");
        await this.provisionArticles(input);
        const hits = await this.store.knowledge.searchAuthorized(context, interests[1], 3);
        const candidates = [];
        for (const hit of hits) {
          const statement = `可能持续关注 ${hit.title} 涉及的主题；仅由公开文章推断，尚待本人确认。`;
          candidates.push(
            await this.store.learning.createCandidate(context, {
              candidateKind: "derived",
              subject: { kind: "user", id: input.caller.principalId },
              scope: { type: "global" },
              proposedType: "preference",
              statement,
              content: { statement },
              source: { kind: "external", ref: hit.url },
              sourceEvidence: [
                {
                  evidenceId: randomUUID(),
                  kind: "document_excerpt",
                  ref: hit.url,
                  excerpt: hit.snippet,
                  capturedAt: new Date().toISOString(),
                  trustLevel: "low",
                  metadata: {
                    authorizationDecisionId: hit.receipt.article.decisionId,
                    sourceReadRunId: input.run.id,
                    digest: hit.digest,
                  },
                },
              ],
              confidence: 0.35,
              sensitivity: "confidential",
              mergeHint: { strategy: "manual_review_required" },
              extensions: { websiteDigest: hit.digest },
            }),
          );
        }
        await this.evidence(input, {
          type: "website_interest_candidates",
          candidateIds: candidates.map((candidate) => candidate.candidateId),
        });
        return {
          status: "succeeded",
          runtimeAttempted: false,
          text: candidates.length
            ? `已生成 ${candidates.length} 条待审核兴趣线索。使用 /memory candidates 查看，再决定是否确认。`
            : "没有找到相关网站文章，未生成兴趣线索。",
        };
      }
      if (/^\/knowledge\s+status$/iu.test(text)) {
        const request = {
          ...context,
          resourceId: WEBSITE_KNOWLEDGE_RESOURCE,
          action: WEBSITE_KNOWLEDGE_READ_ACTION,
        };
        const count = await this.store.authorization.withAuthorizedResource(
          request,
          async () => (await this.store.knowledge.currentArticleResources()).length,
        );
        return {
          status: "succeeded",
          runtimeAttempted: false,
          text: `网站知识库当前收录 ${count} 篇文章。`,
        };
      }
      return {
        status: "succeeded",
        runtimeAttempted: false,
        text: "使用 /knowledge sync 同步网站，enable 或 disable 控制自动同步，status 查看文章数量，interests 加主题生成待审核兴趣线索。",
      };
    } catch (error) {
      await this.evidence(input, {
        type: "knowledge_progress_action",
        status: "denied_or_failed",
        reason: error instanceof AccessDeniedError ? "authorization_denied" : "action_failed",
      });
      return {
        status: "failed",
        failureCode: "gate_refused",
        runtimeAttempted: false,
        text: "当前操作未完成。请检查身份、来源权限或网站同步状态。",
      };
    }
  }

  async load(input: ExecutionInput) {
    const context = operation(input);
    let hits: WebsiteKnowledgeHit[] = [];
    let progress: LearningProgressRecord[] = [];
    try {
      await this.provisionArticles(input);
      hits = await this.store.knowledge.searchAuthorized(context, input.text.slice(0, 500), 3);
    } catch {
      await this.evidence(input, { type: "website_knowledge_context", status: "unavailable" });
    }
    if (input.executionMode === undefined) {
      try {
        progress = await this.store.progress.list(context, { query: input.text, limit: 4 });
      } catch {
        await this.evidence(input, { type: "learning_progress_context", status: "unavailable" });
      }
    }
    await this.evidence(input, {
      type: "knowledge_progress_context",
      articleDigests: hits.map((hit) => hit.digest),
      progressIds: progress.map((record) => record.id),
    });
    const items: NonNullable<ExecutionInput["personalContext"]> = [
      ...hits.map((hit) => ({
        kind: "website" as const,
        text: JSON.stringify({
          title: hit.title,
          url: hit.url,
          excerpt: hit.snippet,
          publishedAt: hit.publishedAt,
          fetchedAt: hit.fetchedAt,
          syncedAt: hit.syncedAt,
          digest: hit.digest,
        }),
      })),
      ...progress.map((record) => ({
        kind: "learning_progress" as const,
        text: JSON.stringify({
          kind: record.kind,
          state: record.state,
          statement: record.statement,
          confidence: record.confidence,
          updatedAt: record.updatedAt,
        }),
      })),
    ];
    return {
      items,
      recordProjection: async (included: boolean) => {
        await this.evidence(input, {
          type: "knowledge_progress_projection",
          status: included ? "included" : "omitted_for_budget",
          articleDigests: included ? hits.map((hit) => hit.digest) : [],
          progressIds: included ? progress.map((record) => record.id) : [],
        });
      },
      reauthorize: async () => {
        await this.store.knowledge.recheckAuthorized(context, hits);
        await this.store.progress.authorizeContext(context, progress);
      },
    };
  }
}
