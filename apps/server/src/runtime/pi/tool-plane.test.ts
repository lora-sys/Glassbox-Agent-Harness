import { describe, expect, it } from "vite-plus/test";
import { QQ_CAPABILITIES } from "../../channels/onebot/capabilities.js";
import { FakeHerdrBridge } from "../../ops/fake-herdr-bridge.js";
import { AuthorizedOpsService } from "../../ops/service.js";
import { openDomainStore } from "../../persistence/index.js";
import { createOpsTools } from "./ops-tools.js";
import {
  GLASSBOX_HOST_EXCLUDED_PI_TOOLS,
  PI_BUILTIN_TOOLS,
  PROFILE_SELECTION,
  TOOL_DESCRIPTORS,
  TOOL_SURFACE_POLICY_VERSION,
  assertProfileSelectionComplete,
  describeToolDrift,
  describeToolSurface,
  toolDescriptor,
  toolOperationalState,
  toolOutcomeFromFailure,
} from "./tool-plane.js";

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

  it("describes Pi built-ins as host-only so no policy can mistake them for product Tools", () => {
    for (const name of GLASSBOX_HOST_EXCLUDED_PI_TOOLS) {
      const descriptor = toolDescriptor(name);
      expect(descriptor, name).toBeDefined();
      expect(descriptor?.origin).toBe("pi_builtin");
      // A built-in is not an authorized product capability: it has no Glassbox Action.
      expect(descriptor?.authorization).toBeNull();
      expect(descriptor?.discovery).toBe("host_only");
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
    ).toBe("unknown");
  });

  it("does not let a denied authorization masquerade as readiness", () => {
    expect(toolOperationalState({ ...registered, authorization: "denied" })).toBe("registered");
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
