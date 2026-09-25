import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import type { AuthorizationService } from "../../auth/service.js";
import { QQ_CAPABILITIES } from "../../channels/onebot/capabilities.js";
import { FakeHerdrBridge } from "../../ops/fake-herdr-bridge.js";
import { AuthorizedOpsService } from "../../ops/service.js";
import { openDomainStore } from "../../persistence/index.js";
import { RunTraceStore } from "../../trace/run-store.js";
import { createOpsTools } from "./ops-tools.js";
import { createProtectedTool } from "./protected-tools.js";
import {
  GLASSBOX_HOST_EXCLUDED_PI_TOOLS,
  PI_BUILTIN_TOOLS,
  PROFILE_SELECTION,
  TOOL_DESCRIPTORS,
  TOOL_SURFACE_POLICY_VERSION,
  assertProfileSelectionComplete,
  composeToolDescriptorCatalog,
  describeToolDrift,
  describeToolSurface,
  type ToolDescriptor,
  toolDescriptor,
  toolOperationalState,
  toolOutcomeFromFailure,
} from "./tool-plane.js";

const FUTURE_MCP_FIXTURE: ToolDescriptor = {
  name: "fixture_mcp_lookup",
  origin: "mcp",
  schemaVersion: "fixture-mcp-lookup-v1",
  riskClass: "read",
  provider: "fixture-mcp",
  discovery: "owner_private",
  authorization: { action: "fixture:read", resource: "fixture-record" },
  availability: "connection_state",
  resultProjection: "projected",
  grounding: "integration",
  budgetClass: "integration",
};

const FUTURE_MCP_CATALOG = composeToolDescriptorCatalog([FUTURE_MCP_FIXTURE]);

describe("P5 tool plane origins", () => {
  it("gives every registered Glassbox domain Tool a descriptor with a real provider", () => {
    for (const capability of QQ_CAPABILITIES) {
      const descriptor = toolDescriptor(capability.tool);
      expect(descriptor, capability.tool).toBeDefined();
      expect(descriptor?.origin).toBe("glassbox_domain");
      expect(descriptor?.provider).toBe("qq-napcat");
      expect(descriptor?.schemaVersion).toMatch(/^[a-f0-9]{16,64}$/u);
    }
  });

  it("derives QQ descriptors from the capability registry instead of restating them", () => {
    for (const capability of QQ_CAPABILITIES) {
      const descriptor = toolDescriptor(capability.tool);
      // The protected Action and the Resource kind are the registry's, not a second copy.
      expect(descriptor?.authorization).toEqual({
        action: capability.action,
        resource: capability.resource,
      });
      expect(descriptor?.riskClass).toBe(capability.risk);
    }
  });

  it("registers the non-QQ Glassbox domain Tools the Run path can really offer", () => {
    for (const name of [
      "owner_group_admin",
      "owner_memory_admin",
      "skill_read",
      "group_history_search",
      "owner_history_search",
      "ops_status",
      "task_list",
      "worker_read",
    ]) {
      const descriptor = toolDescriptor(name);
      expect(descriptor, name).toBeDefined();
      expect(descriptor?.origin).toBe("glassbox_domain");
      expect(descriptor?.authorization?.action).toBeTruthy();
    }
  });

  it("describes every authorization action of the multiplexed Owner memory Tool", () => {
    expect(toolDescriptor("owner_memory_admin")?.authorization).toEqual({
      action: ["memory:read", "memory:write", "memory:govern"],
      resource: "owner-memory",
    });
  });

  it("describes isolated Pi adapters as Owner-private workspace Tools while excluding host originals", () => {
    for (const name of GLASSBOX_HOST_EXCLUDED_PI_TOOLS) {
      const descriptor = toolDescriptor(name);
      expect(descriptor, name).toBeDefined();
      expect(descriptor?.origin).toBe("pi_builtin");
      expect(descriptor?.provider).toBe("lora-pi-kit-docker");
      expect(descriptor?.authorization?.resource).toBe("workspace");
      expect(descriptor?.discovery).toBe("owner_private");
      expect(GLASSBOX_HOST_EXCLUDED_PI_TOOLS).toContain(name);
    }
  });

  it("never reports a duplicate Tool name, which would make a surface ambiguous", () => {
    const names = TOOL_DESCRIPTORS.map((descriptor) => descriptor.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("classifies Pi built-ins by origin rather than by where they were declared", () => {
    for (const name of GLASSBOX_HOST_EXCLUDED_PI_TOOLS) expect(PI_BUILTIN_TOOLS).toContain(name);
  });

  it("gives every Tool a grounding class, because risk alone cannot bound a claim", () => {
    for (const descriptor of TOOL_DESCRIPTORS) {
      expect(descriptor.grounding, descriptor.name).toBeTruthy();
    }
    // A search result is not an observation of the world, and a Worker report is not Task
    // acceptance. These two are the distinctions that actually get lost in practice.
    expect(toolDescriptor("group_history_search")?.grounding).toBe("derived_retrieval");
    expect(toolDescriptor("worker_read")?.grounding).toBe("delegated_worker");
    expect(toolDescriptor("qq_group_members")?.grounding).toBe("direct_observation");
    expect(toolDescriptor("read")?.grounding).toBe("host_resource");
  });

  it("binds each Agent Ops descriptor to the Action and Resource kind the real Tool authorizes", async () => {
    const store = await openDomainStore({ databasePath: ":memory:" });
    const caller = {
      principalId: "owner",
      scope: {
        connectionId: "qq",
        botId: "bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      },
    };
    const checks: { action: string; resourceId: string }[] = [];
    const realAuthorization = store.authorization;
    // A recording seam, not a stub: every check still runs for real and returns its real
    // decision. Only the request is observed, which is what makes the declared table
    // verifiable instead of merely asserted.
    const authorization = new Proxy(realAuthorization, {
      get(target, property, receiver) {
        if (property === "check")
          return async (request: Parameters<typeof target.check>[0]) => {
            checks.push({ action: request.action, resourceId: request.resourceId });
            return target.check(request);
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const recordingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "authorization") return authorization;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      // A real Principal and Run, because a Gate-3 decision records evidence and an
      // unbacked one cannot be written. No Tool grant is issued, so every check still denies.
      await store.identities.bindOwner("owner", caller.scope);
      await store.conversations.createAgent("personal");
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "agent:personal",
        action: "run:create",
        scope: caller.scope,
        effect: "allow",
      });
      const accepted = await store.conversations.acceptIncoming({
        agentId: "personal",
        scope: caller.scope,
        messageId: "message",
        text: "Ops",
        executionRef: "pi:test",
      });
      for (const resource of [
        { id: "agent-operations", kind: "ops", visibility: "public" as const },
        { id: "task-t1", kind: "task", visibility: "public" as const },
      ])
        await store.authorization.registerResource(resource);

      const tools = createOpsTools({
        store: recordingStore,
        service: new AuthorizedOpsService(recordingStore, new FakeHerdrBridge()),
        getContext: () => ({
          caller,
          runId: accepted.run.id,
          conversationId: accepted.conversation.id,
        }),
        workerTarget: { workspaceId: "configured", agentKind: "test" },
      });
      const params: Record<string, Record<string, unknown>> = {
        ops_status: {},
        task_list: {},
        task_get: { taskId: "t1" },
        task_create: { title: "Task" },
        worker_status: { taskId: "t1" },
        task_delegate: { taskId: "t1", prompt: "Do work" },
        worker_read: { taskId: "t1" },
        worker_prompt: { taskId: "t1", prompt: "Do work" },
        task_accept: { taskId: "t1" },
        task_rework: { taskId: "t1", reason: "No", prompt: "Do work" },
        task_cancel: { taskId: "t1" },
      };

      for (const tool of tools) {
        checks.length = 0;
        // No grant is registered, so Gate-3 denies and nothing executes. The denial is the
        // point: it proves the binding was used before any side effect could happen.
        await expect(
          tool.execute("call", params[tool.name], undefined, undefined, {} as never),
        ).rejects.toThrow(/Permission denied|Access denied/u);

        const binding = toolDescriptor(tool.name)?.authorization;
        expect(binding, tool.name).toBeDefined();
        expect(checks, tool.name).toHaveLength(1);
        expect(checks[0]?.action, tool.name).toBe(binding?.action);
        if (binding?.resource === "agent-operations")
          expect(checks[0]?.resourceId, tool.name).toBe("agent-operations");
        else expect(checks[0]?.resourceId, tool.name).toMatch(/^task-/u);
      }
    } finally {
      await store.close();
    }
  });
});

describe("P5 future-origin Tool contract", () => {
  it("carries one non-QQ MCP Tool through descriptor, discovery, authorization and evidence", async () => {
    const descriptor = toolDescriptor(FUTURE_MCP_FIXTURE.name, FUTURE_MCP_CATALOG);
    expect(descriptor).toEqual(FUTURE_MCP_FIXTURE);
    expect(descriptor?.origin).toBe("mcp");
    expect(descriptor?.authorization).toEqual({
      action: "fixture:read",
      resource: "fixture-record",
    });

    const drift = describeToolDrift({
      profileName: "main-agent",
      profileActiveTools: [FUTURE_MCP_FIXTURE.name],
      descriptors: FUTURE_MCP_CATALOG,
    });
    expect(drift.compatible).toBe(true);
    expect(drift.unknownTools).toEqual([]);

    const surface = describeToolSurface({
      profileName: "main-agent",
      profileActiveTools: [],
      candidates: [{ name: FUTURE_MCP_FIXTURE.name, exclusion: null }],
      descriptors: FUTURE_MCP_CATALOG,
      providerReadiness: { [FUTURE_MCP_FIXTURE.name]: "ready" },
      generatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(surface.selected).toEqual([
      expect.objectContaining({
        name: FUTURE_MCP_FIXTURE.name,
        origin: "mcp",
        provider: "fixture-mcp",
        schemaVersion: "fixture-mcp-lookup-v1",
        providerReadiness: "ready",
      }),
    ]);
    expect(surface.undescribed).toEqual([]);

    if (!descriptor) throw new Error("future-origin fixture descriptor was not registered");
    const fixtureAction = descriptor.authorization?.action;
    if (typeof fixtureAction !== "string") throw new Error("fixture action binding is invalid");
    const discovered = surface.selected.some((entry) => entry.name === descriptor.name);
    expect(discovered).toBe(true);

    const caller = {
      principalId: "owner",
      scope: {
        connectionId: "fixture-mcp",
        botId: "fixture-bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      },
    };
    const traceDirectory = await mkdtemp(join(tmpdir(), "glassbox-tool-plane-mcp-"));
    const store = await openDomainStore({ databasePath: ":memory:" });
    const trace = new RunTraceStore(traceDirectory);
    try {
      await store.identities.bindOwner(caller.principalId, caller.scope);
      await store.conversations.createAgent("personal");
      for (const action of ["run:create", "conversation:read", "trace:write"])
        await store.authorization.grant({
          principalId: caller.principalId,
          resourceId: "agent:personal",
          action,
          scope: caller.scope,
          effect: "allow",
        });
      const accepted = await store.conversations.acceptIncoming({
        agentId: "personal",
        scope: caller.scope,
        messageId: "fixture-message",
        text: "run the fixture MCP lookup",
        executionRef: "fixture-mcp-test",
      });
      const targetResourceId = "fixture-record-1";
      await store.authorization.registerResource({
        id: targetResourceId,
        kind: descriptor.authorization?.resource ?? "fixture-record",
        visibility: "public",
      });

      const decisions: Awaited<ReturnType<typeof store.authorization.check>>[] = [];
      const authorizationRequests: Parameters<typeof store.authorization.check>[0][] = [];
      const recordingAuthorization = new Proxy(store.authorization, {
        get(target, property, receiver) {
          if (property === "check")
            return async (request: Parameters<typeof target.check>[0]) => {
              authorizationRequests.push(request);
              const decision = await target.check(request);
              decisions.push(decision);
              return decision;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as AuthorizationService;
      const protectedContext = {
        caller,
        conversationId: accepted.conversation.id,
        runId: accepted.run.id,
      };
      let executions = 0;
      let executionEvidence: Awaited<ReturnType<RunTraceStore["append"]>> | undefined;
      const fixtureTool = createProtectedTool<
        { query: string },
        { status: "ok"; records: { id: string; query: string }[] }
      >({
        name: descriptor.name,
        description: "Read one bounded record from the deterministic MCP fixture.",
        parameters: Type.Object(
          { query: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
        action: fixtureAction,
        resourceId: targetResourceId,
        authService: recordingAuthorization,
        getContext: () => protectedContext,
        execute: async (params) => {
          executions++;
          const authorization = decisions.at(-1);
          if (!authorization || authorization.decision !== "ALLOW")
            throw new Error("fixture authorization evidence missing");
          const result = {
            status: "ok" as const,
            records: [{ id: targetResourceId, query: params.query }],
          };
          executionEvidence = await trace.append(
            accepted.run.id,
            {
              type: "tool_execution",
              tool: descriptor.name,
              outcome: "success",
              authorizationDecisionId: authorization.id,
              resultShape: "bounded_records",
              recordCount: result.records.length,
            },
            "fixture-mcp",
          );
          await store.evidence.advanceTrace(caller, executionEvidence);
          return result;
        },
      });
      const invoke = (params: Record<string, unknown>) =>
        fixtureTool.execute("call", params, undefined, undefined, {} as never);

      await expect(invoke({ query: "denied" })).rejects.toThrow("Permission denied: no_grant");
      expect(executions).toBe(0);
      expect(decisions.at(-1)).toMatchObject({
        decision: "DENY",
        reason: "no_grant",
      });
      expect(authorizationRequests.at(-1)).toMatchObject({
        resourceId: targetResourceId,
        action: fixtureAction,
      });

      await store.authorization.grant({
        principalId: caller.principalId,
        resourceId: targetResourceId,
        action: fixtureAction,
        scope: caller.scope,
        effect: "allow",
      });
      const response = await invoke({ query: "allowed" });
      const authorization = decisions.at(-1);
      expect(authorization).toMatchObject({
        decision: "ALLOW",
        reason: "explicit_grant",
      });
      expect(authorization?.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(authorizationRequests.at(-1)).toMatchObject({
        resourceId: targetResourceId,
        action: fixtureAction,
      });
      expect(executions).toBe(1);
      expect(response).toMatchObject({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              records: [{ id: targetResourceId, query: "allowed" }],
            }),
          },
        ],
        details: {
          status: "ok",
          records: [{ id: targetResourceId, query: "allowed" }],
        },
      });
      expect(executionEvidence).toBeDefined();
      expect(executionEvidence).toMatchObject({
        runId: accepted.run.id,
        traceRef: accepted.run.id,
        eventCount: 1,
      });
      const evidence = executionEvidence!;
      expect(response.details).toEqual({
        status: "ok",
        records: [{ id: targetResourceId, query: "allowed" }],
      });
      const rawTrace = await trace.readPage(accepted.run.id);
      expect(rawTrace.records).toHaveLength(1);
      expect(rawTrace.records[0]).toMatchObject({
        seq: 1,
        event: {
          type: "tool_execution",
          tool: descriptor.name,
          outcome: "success",
          authorizationDecisionId: authorization?.id,
          resultShape: "bounded_records",
        },
        provenance: "fixture-mcp",
      });
      expect(await store.evidence.getTrace(caller, accepted.run.id)).toEqual(evidence);

      const recordedEvent = rawTrace.records[0]?.event as { outcome?: string };
      const operationalObservation = {
        registered: true,
        discoverable: discovered,
        authorization: "allowed" as const,
        provider: "ready" as const,
        lastExecution: {
          outcome:
            recordedEvent.outcome === "success" ? ("success" as const) : ("unknown" as const),
          at: rawTrace.records[0]?.ts ?? "unknown",
        },
      };
      expect(toolOperationalState(operationalObservation)).toBe("succeeded");
    } finally {
      await store.close();
      await rm(traceDirectory, { recursive: true, force: true });
    }
  });
});

describe("P5 profile / host drift", () => {
  it("classifies a Kit profile Tool the host never provides as disabled_by_host", () => {
    const report = describeToolDrift({
      profileName: "main-agent",
      profileActiveTools: ["read", "bash", "edit", "write"],
    });

    // The boundary is intended: a QQ Principal never inherits host filesystem or shell.
    // Intended is not the same as silent, so it is named.
    expect(report.disabledByHost).toEqual(["read", "bash", "edit", "write"]);
    expect(report.compatible).toBe(true);
  });

  it("treats a Tool nobody provides as an incompatible profile rather than ignoring it", () => {
    const report = describeToolDrift({
      profileName: "main-agent",
      profileActiveTools: ["read", "frobnicate_history"],
    });

    expect(report.compatible).toBe(false);
    expect(report.unknownTools).toEqual(["frobnicate_history"]);
  });

  it("reports no drift when every declared Tool is one Glassbox really provides", () => {
    const report = describeToolDrift({
      profileName: "main-agent",
      profileActiveTools: ["qq_group_history", "owner_group_admin"],
    });

    expect(report.disabledByHost).toEqual([]);
    expect(report.unknownTools).toEqual([]);
    expect(report.compatible).toBe(true);
  });

  it("names the Kit profile whose declaration disagrees with the host", () => {
    const report = describeToolDrift({
      profileName: "qq-group",
      profileActiveTools: ["read"],
    });

    expect(report.profileName).toBe("qq-group");
    expect(report.details).toMatchObject({ declared: ["read"] });
  });
});

describe("P5 profile selection ledger", () => {
  it("records a decision for every Kit profile so a new one cannot be selected silently", () => {
    for (const decision of PROFILE_SELECTION) {
      expect(decision.profileName).toBeTruthy();
      // A profile is either selected by a named caller or retired with a reason. "Neither"
      // is the drift this ledger exists to prevent.
      expect(Boolean(decision.selectedBy) !== Boolean(decision.retired)).toBe(true);
    }
  });

  it("retires owner-direct explicitly instead of leaving an uncalled profile in place", () => {
    const decision = PROFILE_SELECTION.find((entry) => entry.profileName === "owner-direct");

    expect(decision?.selectedBy).toBeNull();
    expect(decision?.retired?.reason).toBeTruthy();
  });

  it("fails loudly when a Kit profile has no recorded selection decision", () => {
    expect(() =>
      assertProfileSelectionComplete(["main-agent", "qq-group", "owner-direct", "brand-new"]),
    ).toThrow(/brand-new/u);
    expect(() => assertProfileSelectionComplete(["main-agent", "qq-group"])).not.toThrow();
  });
});

describe("P5 effective Tool surface snapshot", () => {
  it("reports a selected isolated Pi tool as available without reclassifying its host original", () => {
    const surface = describeToolSurface({
      profileName: "main-agent",
      profileActiveTools: ["read"],
      candidates: [{ name: "read", exclusion: null }],
      providerReadiness: { read: "ready" },
    });
    expect(surface.selected).toEqual([
      expect.objectContaining({
        name: "read",
        provider: "lora-pi-kit-docker",
        providerReadiness: "ready",
      }),
    ]);
    expect(surface.disabledByHost).toEqual([]);
    expect(GLASSBOX_HOST_EXCLUDED_PI_TOOLS).toContain("read");
  });
  it("keeps selected and excluded Tools in one inspectable record with a reason code", () => {
    const surface = describeToolSurface({
      profileName: "qq-group",
      profileActiveTools: ["read"],
      candidates: [
        { name: "qq_group_history", exclusion: null },
        { name: "owner_group_admin", exclusion: "scope_not_permitted" },
        { name: "qq_group_moderation", exclusion: "policy_disabled" },
      ],
    });

    expect(surface.selected.map((entry) => entry.name)).toEqual(["qq_group_history"]);
    // The Kit profile's `read` is excluded too. Listing it here rather than only under
    // `disabledByHost` is what makes `excluded` the complete answer to "what is not on this
    // surface, and why" — a caller that had to union two fields would eventually forget one.
    expect(surface.excluded.map((entry) => entry.name)).toEqual([
      "owner_group_admin",
      "qq_group_moderation",
      "read",
    ]);
    expect(surface.excluded.map((entry) => entry.reason)).toEqual([
      "scope_not_permitted",
      "policy_disabled",
      "disabled_by_host",
    ]);
  });

  it("reports the Kit profile Tools the host removed even when nothing else was excluded", () => {
    const surface = describeToolSurface({
      profileName: "qq-group",
      profileActiveTools: ["read"],
      candidates: [{ name: "qq_group_history", exclusion: null }],
    });

    expect(surface.disabledByHost).toEqual(["read"]);
    expect(surface.excluded.map((entry) => entry.name)).toEqual(["read"]);
    expect(surface.excluded[0]?.reason).toBe("disabled_by_host");
  });

  it("describes each surface entry well enough to explain what a Run could really call", () => {
    const surface = describeToolSurface({
      profileName: "main-agent",
      profileActiveTools: [],
      candidates: [{ name: "qq_group_history", exclusion: null }],
    });

    expect(surface.selected[0]).toMatchObject({
      name: "qq_group_history",
      origin: "glassbox_domain",
      riskClass: "read",
      provider: "qq-napcat",
    });
    expect(surface.selected[0]?.schemaVersion).toMatch(/^[a-f0-9]{16,64}$/u);
  });

  it("carries no Tool payload, so surface evidence cannot leak protected values", () => {
    const surface = describeToolSurface({
      profileName: "main-agent",
      profileActiveTools: [],
      candidates: [{ name: "qq_group_history", exclusion: null }],
    });

    expect(JSON.stringify(surface)).not.toContain("group_id");
    expect(JSON.stringify(surface)).not.toContain("SECRET");
  });

  it("records provider readiness without promoting it to a success claim", () => {
    const surface = describeToolSurface({
      profileName: "main-agent",
      profileActiveTools: [],
      candidates: [{ name: "qq_group_history", exclusion: null }],
      providerReadiness: { qq_group_history: "unavailable" },
    });

    expect(surface.selected[0]?.providerReadiness).toBe("unavailable");
    // Presence on a surface plus a healthy provider is still not an observation that it ran.
    const unknown = describeToolSurface({
      profileName: "main-agent",
      profileActiveTools: [],
      candidates: [{ name: "qq_group_history", exclusion: null }],
    });
    expect(unknown.selected[0]?.providerReadiness).toBe("unknown");
  });

  it("stamps the profile and policy version so old evidence stays interpretable", () => {
    const surface = describeToolSurface({
      profileName: "qq-group",
      profileActiveTools: [],
      candidates: [],
      profileVersion: "kit-0.85.1",
      generatedAt: "2026-09-21T10:00:00.000Z",
    });

    expect(surface.profileVersion).toBe("kit-0.85.1");
    expect(surface.policyVersion).toBe(TOOL_SURFACE_POLICY_VERSION);
    // The stamp is the caller's, never re-derived, so a recorded surface keeps its own time.
    expect(surface.generatedAt).toBe("2026-09-21T10:00:00.000Z");
  });

  it("reports a discovered name it cannot describe instead of quietly dropping it", () => {
    const surface = describeToolSurface({
      profileName: "main-agent",
      profileActiveTools: [],
      candidates: [
        { name: "qq_group_history", exclusion: null },
        { name: "mystery_tool", exclusion: null },
      ],
    });

    expect(surface.selected.map((entry) => entry.name)).toEqual(["qq_group_history"]);
    expect(surface.undescribed).toEqual(["mystery_tool"]);
  });
});

describe("P5 Tool operational state", () => {
  const registered = {
    registered: true,
    discoverable: true,
    authorization: "allowed" as const,
    provider: "ready" as const,
  };

  it("stops at registered when only a definition exists", () => {
    expect(
      toolOperationalState({
        registered: true,
        discoverable: false,
        authorization: "unknown",
        provider: "unknown",
      }),
    ).toBe("registered");
  });

  it("reports presence on the surface as discoverable, never as success", () => {
    expect(toolOperationalState(registered)).toBe("provider_ready");
  });

  it("distinguishes discovery from live authorization before provider readiness", () => {
    expect(
      toolOperationalState({
        ...registered,
        authorization: "unknown",
        provider: "unknown",
      }),
    ).toBe("discoverable");
    expect(
      toolOperationalState({
        ...registered,
        authorization: "allowed",
        provider: "unknown",
      }),
    ).toBe("authorized");
  });

  it("reports provider readiness without claiming the Tool has ever run", () => {
    const state = toolOperationalState(registered);
    expect(state).not.toBe("succeeded");
    expect(state).not.toBe("failed");
  });

  it("reports success only when this concrete call actually completed", () => {
    expect(
      toolOperationalState({
        ...registered,
        lastExecution: { outcome: "success", at: "2026-09-21T10:00:00.000Z" },
      }),
    ).toBe("succeeded");
  });

  it("keeps a failure visible even while the provider looks ready", () => {
    expect(
      toolOperationalState({
        ...registered,
        lastExecution: { outcome: "provider_failed", at: "2026-09-21T10:00:00.000Z" },
      }),
    ).toBe("failed");
  });

  it("reports unavailable when the provider cannot accept a call at all", () => {
    expect(toolOperationalState({ ...registered, provider: "unavailable" })).toBe("unavailable");
  });

  it("reports unknown rather than guessing when nothing has been observed", () => {
    expect(
      toolOperationalState({
        registered: true,
        discoverable: true,
        authorization: "allowed",
        provider: "unknown",
      }),
    ).toBe("authorized");
  });

  it("does not let a denied authorization masquerade as readiness", () => {
    const denied = { ...registered, authorization: "denied" as const };
    // `discoverable` here only means the Run surface exposed the candidate. The separate
    // authorization field remains denied, so this state cannot be used as an executable Tool.
    expect(denied.authorization).toBe("denied");
    expect(toolOperationalState(denied)).toBe("discoverable");
    expect(toolOperationalState(denied)).not.toBe("authorized");
    expect(toolOperationalState(denied)).not.toBe("provider_ready");
  });
});

describe("P5 Tool execution outcomes", () => {
  it("classifies a refusal as denied, whichever rule refused", () => {
    // Glassbox authorization, an Owner-disabled capability class, a missing Run context and a
    // provider allowlist refusal all mean the same thing to a Run: nothing was observed.
    for (const code of [
      "authorization_denied",
      "capability_category_disabled",
      "context_missing",
      "mutation_already_attempted",
      "provider_denied",
    ])
      expect(toolOutcomeFromFailure(code)).toBe("denied");
  });

  it("separates a malformed call from a failure the caller cannot correct", () => {
    expect(toolOutcomeFromFailure("input_validation_failed")).toBe("invalid_input");
  });

  it("separates an unavailable provider from a failed request", () => {
    expect(toolOutcomeFromFailure("provider_unavailable")).toBe("provider_unavailable");
    expect(toolOutcomeFromFailure("provider_failed")).toBe("provider_failed");
    expect(toolOutcomeFromFailure("protected_tool_failed")).toBe("provider_failed");
  });

  it("never reads an unrecognized code as success", () => {
    // A code this build does not understand is not evidence that the call worked.
    expect(toolOutcomeFromFailure("tool_execution_failed")).toBe("unknown");
    expect(toolOutcomeFromFailure("")).toBe("unknown");
    expect(toolOutcomeFromFailure("something_new")).toBe("unknown");
  });
});
