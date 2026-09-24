import type { IncomingMessage } from "node:http";
import { CHANNEL_SAFE_ERRORS } from "@glassbox/contracts";
import type { ExecutorConfiguration } from "../config/executors.js";
import type { CallerContext } from "../identity/scope.js";
import type { DomainStore } from "../application/domain-store.js";
import type { RunService } from "../execution/run-service/index.js";
import type { RunTraceStore } from "../trace/run-store.js";
import type { TraceEntry } from "../trace/store.js";
import { RunEvalError, type createRunEvaluator } from "../eval/index.js";
import type { CapabilityProbeReport } from "../channels/onebot/capability-probe.js";
import type { PublicChannelProfile } from "@glassbox/contracts";
import { ManagementError } from "./access.js";
import { readManagementJson } from "./http.js";
import {
  projectToolPlaneDiagnostics,
  TOOL_PLANE_DIAGNOSTIC_RECORD_CAP,
} from "./tool-plane-diagnostics.js";
import { ChannelConfigurationError } from "../config/channel-profiles.js";
import { ExecutorBusyError } from "../config/executors.js";

const OWNER_ID = "owner";

type RouteStore = {
  authorization: Pick<DomainStore["authorization"], "revoke">;
  tasks: Pick<DomainStore["tasks"], "recordTrace">;
  management: Pick<DomainStore["management"], "listConversations" | "listRuns">;
  lifecycle: Pick<DomainStore["lifecycle"], "listDeliveries">;
  evidence: Pick<DomainStore["evidence"], "getTrace">;
  conversations: Pick<DomainStore["conversations"], "getRun">;
};

export interface ManagementRouteDependencies {
  store: RouteStore;
  grantOpsPermissions(input: unknown): Promise<unknown>;
  executors: Pick<ExecutorConfiguration, "list" | "save" | "check">;
  listChannels(): PublicChannelProfile[];
  saveChannel(input: unknown): Promise<PublicChannelProfile>;
  connectChannel(id: string): Promise<PublicChannelProfile>;
  disconnectChannel(id: string): Promise<PublicChannelProfile>;
  probeCapabilities(channelId: string, groupId: string): Promise<CapabilityProbeReport>;
  groupRoleAudit(channelId: string, groupId: string): Promise<unknown>;
  runCaller(runId: string): Promise<CallerContext>;
  runs: Pick<RunService, "cancel">;
  trace: Pick<RunTraceStore, "readPage">;
  evaluator: ReturnType<typeof createRunEvaluator>;
}

/** Dispatch the management routes owned by ManagementApplication. */
export async function routeManagementRequest(
  request: IncomingMessage,
  dependencies: ManagementRouteDependencies,
): Promise<{ status: number; body: unknown } | undefined> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (request.method === "POST" && path === "/manage/ops/grants") {
    const result = await dependencies.grantOpsPermissions(await readManagementJson(request));
    return { status: 200, body: result };
  }
  const revokeOpsGrant = /^\/manage\/ops\/grants\/([a-zA-Z0-9-]{1,80})\/revoke$/u.exec(path);
  if (request.method === "POST" && revokeOpsGrant) {
    await dependencies.store.authorization.revoke(revokeOpsGrant[1]!);
    await dependencies.store.tasks.recordTrace({
      type: "authorization.revoked",
      principalId: OWNER_ID,
      data: { grantId: revokeOpsGrant[1], authority: "local-management" },
    });
    return { status: 200, body: { revoked: true } };
  }
  const options = {
    ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
    limit: 30,
  };
  const ok = (body: unknown) => ({ status: 200, body });
  try {
    if (path === "/manage/executors") {
      if (request.method === "GET") return ok({ executors: await dependencies.executors.list() });
      if (request.method === "POST")
        return ok({
          executor: await dependencies.executors.save(await readManagementJson(request)),
        });
    }
    if (request.method === "POST" && path === "/manage/executors/claude-code/check") {
      await readManagementJson(request);
      return ok({ executor: await dependencies.executors.check() });
    }
    if (path === "/manage/channels") {
      if (request.method === "GET") return ok({ channels: dependencies.listChannels() });
      if (request.method === "POST")
        return ok({ channel: await dependencies.saveChannel(await readManagementJson(request)) });
    }
    const channelAction = /^\/manage\/channels\/([A-Za-z0-9_-]+)\/(connect|disconnect)$/u.exec(
      path,
    );
    if (request.method === "POST" && channelAction)
      return ok({
        channel:
          channelAction[2] === "connect"
            ? await dependencies.connectChannel(channelAction[1]!)
            : await dependencies.disconnectChannel(channelAction[1]!),
      });
    if (request.method === "POST" && path === "/manage/capabilities/probe") {
      const input = await readManagementJson(request);
      const value = (input ?? {}) as Record<string, unknown>;
      if (typeof value.channelId !== "string" || typeof value.groupId !== "string")
        throw new ManagementError("INVALID_REQUEST", "A channel and a group are required");
      return ok({
        probe: await dependencies.probeCapabilities(value.channelId, value.groupId),
      });
    }
    if (request.method === "GET" && path === "/manage/group-role-audit") {
      const channelId = url.searchParams.get("channelId");
      const groupId = url.searchParams.get("groupId");
      if (
        !channelId ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(channelId) ||
        !groupId ||
        !/^[1-9]\d{0,15}$/u.test(groupId)
      )
        throw new ManagementError("INVALID_REQUEST", "A channel and a numeric group are required");
      return ok(await dependencies.groupRoleAudit(channelId, groupId));
    }
    if (request.method === "GET" && path === "/manage/conversations")
      return ok(await dependencies.store.management.listConversations(OWNER_ID, options));
    if (request.method === "GET" && path === "/manage/runs") {
      const conversationId = url.searchParams.get("conversationId");
      if (conversationId && !/^[A-Za-z0-9-]{1,80}$/u.test(conversationId))
        throw new ManagementError("INVALID_REQUEST", "Invalid conversation identifier");
      return ok(
        await dependencies.store.management.listRuns(OWNER_ID, {
          ...options,
          ...(conversationId ? { conversationId } : {}),
        }),
      );
    }
    const runAction =
      /^\/manage\/runs\/([A-Za-z0-9-]+)(?:\/(cancel|trace|tool-plane|deliveries|evals))?$/u.exec(
        path,
      );
    if (runAction) {
      const runId = runAction[1]!;
      const caller = await dependencies.runCaller(runId);
      if (request.method === "POST" && runAction[2] === "evals") {
        const input = await readManagementJson(request);
        if (
          !input ||
          typeof input !== "object" ||
          !("suiteId" in input) ||
          typeof input.suiteId !== "string"
        )
          throw new ManagementError("INVALID_REQUEST", "An Eval suite is required");
        return ok({
          evaluation: await dependencies.evaluator.evaluate(caller, runId, input.suiteId),
        });
      }
      if (request.method === "GET" && runAction[2] === "evals")
        return ok(await dependencies.evaluator.list(caller, runId, options));
      if (request.method === "POST" && runAction[2] === "cancel")
        return ok({ run: await dependencies.runs.cancel(caller, runId) });
      if (request.method === "GET" && runAction[2] === "deliveries")
        return ok(await dependencies.store.lifecycle.listDeliveries(caller, runId, options));
      if (request.method === "GET" && runAction[2] === "trace") {
        const indexed = await dependencies.store.evidence.getTrace(caller, runId);
        if (!indexed) return ok({ records: [], nextCursor: null, indexed: null });
        const { records, nextCursor } = await dependencies.trace.readPage(runId, {
          ...options,
          redactSecrets: true,
        });
        // Recheck after file I/O before returning a protected projection.
        await dependencies.store.conversations.getRun(caller, runId);
        return ok({ records, nextCursor, indexed });
      }
      if (request.method === "GET" && runAction[2] === "tool-plane") {
        const indexed = await dependencies.store.evidence.getTrace(caller, runId);
        const records: TraceEntry<unknown>[] = [];
        let cursor: string | undefined;
        let nextCursor: string | null = null;
        if (indexed) {
          do {
            const page = await dependencies.trace.readPage(runId, {
              ...(cursor ? { cursor } : {}),
              limit: 50,
              redactSecrets: true,
            });
            records.push(...page.records);
            nextCursor = page.nextCursor;
            cursor = page.nextCursor ?? undefined;
          } while (nextCursor && records.length < TOOL_PLANE_DIAGNOSTIC_RECORD_CAP);
        }
        // The projection contains metadata only. Recheck after file I/O so a revoked or
        // otherwise unavailable Owner Run never receives a stale trace view.
        await dependencies.store.conversations.getRun(caller, runId);
        return ok(
          projectToolPlaneDiagnostics({
            runId,
            records,
            complete:
              indexed !== null && nextCursor === null && records.length === indexed.eventCount,
          }),
        );
      }
      if (request.method === "GET" && !runAction[2])
        return ok({ run: await dependencies.store.conversations.getRun(caller, runId) });
    }
    return undefined;
  } catch (error) {
    if (error instanceof RunEvalError)
      throw new ManagementError(
        error.code,
        error.message,
        error.code === "EVAL_SUITE_NOT_FOUND" ? 400 : 409,
      );
    if (error instanceof ExecutorBusyError)
      throw new ManagementError("EXECUTOR_BUSY", error.message, 409);
    if (error instanceof ChannelConfigurationError)
      throw new ManagementError("INVALID_CONFIGURATION", CHANNEL_SAFE_ERRORS.configuration);
    throw error;
  }
}
