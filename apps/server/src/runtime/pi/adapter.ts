import { mkdir } from "node:fs/promises";
import path from "node:path";
import { QQ_SOURCE_CLASSES, type AgentRun, type Conversation } from "@glassbox/contracts";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { KitLoader, type ResolvedKitProfile } from "./kit-loader.js";
import { QQ_CAPABILITY_CATEGORIES } from "../../channels/onebot/capabilities.js";
import { requiredInputClause } from "./protected-tools.js";
import {
  GLASSBOX_HOST_EXCLUDED_PI_TOOLS,
  assertProfileSelectionComplete,
  describeToolSurface,
  toolOutcomeFromFailure,
} from "./tool-plane.js";
import type { EffectiveToolSurface, ToolSurfaceCandidate } from "./tool-plane.js";
import { kitProfileSkillVisibility } from "./skill-visibility.js";
import type {
  PiNormalizedEvent,
  PiRunContext,
  PiRunResult,
  PiRuntimeAdapter,
  PiRuntimeProfileName,
  PiSessionBinding,
} from "./types.js";

interface ActiveSession {
  session: Pick<
    AgentSession,
    "sessionId" | "subscribe" | "prompt" | "abort" | "dispose" | "messages"
  > &
    Partial<Pick<AgentSession, "extensionRunner">>;
  binding: PiSessionBinding;
  runtimeEvidence: Record<string, unknown>;
  authorizedToolNames: readonly string[];
  /** The classified surface, when discovery could report one. Recorded as Run evidence. */
  toolSurface?: EffectiveToolSurface;
  authorizedSkillNames: readonly string[];
  modelVisibleSkillNames: readonly string[];
  skillPolicy: Record<string, unknown>;
}

export interface PiSdkRuntimeOptions {
  kitPath?: string;
  runtimeBaseDir?: string;
  cwd?: string;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  resolveModel?: () => Promise<{ model: Model<any>; modelRuntime: ModelRuntime }>;
  customTools?: ToolDefinition[];
  createTools?: (getContext: () => PiRunContext | undefined) => ToolDefinition[];
  /** Release Run-scoped external resources before the execution context is discarded. */
  onRunEnd?: (context: PiRunContext) => Promise<void>;
  resolveSkillNames?: (
    context: PiRunContext,
    profile: ResolvedKitProfile,
  ) => Promise<{
    names: readonly string[];
    modelVisibleNames?: readonly string[];
    policy?: Record<string, unknown>;
  }>;
  resolveToolNames?: (context: PiRunContext) => Promise<readonly string[]>;
  /**
   * The same discovery, classified.
   *
   * Preferred over `resolveToolNames` when present: a caller that supplies this gets the
   * effective surface recorded as Run evidence, so a Run can explain which Tools were
   * excluded and why. `resolveToolNames` remains for fakes that only need the active names.
   */
  resolveToolCandidates?: (context: PiRunContext) => Promise<readonly ToolSurfaceCandidate[]>;
  onEvent?: (event: PiNormalizedEvent) => void | Promise<void>;
  createSession?: (params: {
    conversation: Conversation;
    profile: ResolvedKitProfile;
    agentDir: string;
    sessionDir: string;
    modelVisibleSkillNames?: readonly string[];
  }) => Promise<ActiveSession["session"]>;
}

/**
 * The content digest of the Kit profile a surface was computed against.
 *
 * Read out of the runtime evidence the Kit loader already fingerprints, rather than hashed
 * again here: two digests of the same file could disagree, and the one on the evidence is the
 * one a reader will compare against.
 */
function profileFingerprint(evidence: Record<string, unknown>, profileName: string): string {
  const fingerprints = evidence.fingerprints;
  if (fingerprints && typeof fingerprints === "object") {
    const value = (fingerprints as Record<string, unknown>)[`profiles/${profileName}.json`];
    if (typeof value === "string") return value;
  }
  return "unknown";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: string; text?: string } =>
        Boolean(part) && typeof part === "object" && "type" in part,
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function glassboxSystemPrompt(modelPrompt: string): string {
  return `${modelPrompt.trim()}\n\nReply in concise plain text suitable for QQ. Follow the response shape and fields the user explicitly requested. Unless the user asks for diagnostics, do not narrate Tool names, Tool parameters, result counts, coverage metadata, internal guidance, or reasoning. Preserve partial-coverage limits when making absence or completeness claims, but do not add unrequested diagnostic sections to a positive match. Do not reveal host paths, internal service addresses, configuration names, or internal identifiers.\n\nTool availability is scoped to the current caller, location, and authorization. A tool missing from the current Run does not mean the product capability is unimplemented. State that the capability is unavailable in the current context. Never invent an unimplemented status, future rollout, or replacement API.`;
}

const SAFE_OWNER_GROUP_CATEGORIES = new Set<string>(QQ_CAPABILITY_CATEGORIES);
const SAFE_OWNER_GROUP_SOURCE_CLASSES = new Set<string>(QQ_SOURCE_CLASSES);

function safeToolInput(toolName: string, args: unknown): Record<string, unknown> | undefined {
  if (toolName !== "owner_group_admin" || !args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  const category =
    typeof input.category === "string" && SAFE_OWNER_GROUP_CATEGORIES.has(input.category)
      ? input.category
      : undefined;
  const sourceClass =
    typeof input.sourceClass === "string" && SAFE_OWNER_GROUP_SOURCE_CLASSES.has(input.sourceClass)
      ? input.sourceClass
      : undefined;
  return {
    ...(typeof input.action === "string" && /^[a-z_]{1,32}$/u.test(input.action)
      ? { action: input.action }
      : {}),
    ...(typeof input.groupId === "string" && /^[1-9]\d{0,15}$/u.test(input.groupId)
      ? { groupId: input.groupId }
      : {}),
    ...(typeof input.skillName === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.skillName)
      ? { skillName: input.skillName }
      : {}),
    ...(category === undefined ? {} : { category }),
    ...(sourceClass === undefined ? {} : { sourceClass }),
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
  };
}

function safeToolFailureCode(result: unknown): string {
  let text = "";
  try {
    const serialized = JSON.stringify(result);
    text = typeof serialized === "string" ? serialized : "";
  } catch {
    return "tool_execution_failed";
  }
  if (text.includes("context_missing")) return "context_missing";
  if (text.includes("Permission denied")) return "authorization_denied";
  if (text.includes("capability_category_disabled")) return "capability_category_disabled";
  // A provider refusal is its own fact: "the bridge is not connected" and "the request was
  // rejected" are not the same as "the Tool broke", and a Run that cannot tell them apart
  // cannot say honestly what it knows.
  for (const code of [
    "provider_unavailable",
    "provider_denied",
    "provider_failed",
    "provider_unknown",
  ])
    if (text.includes(code)) return code;
  if (text.includes("protected_tool_failed")) return "protected_tool_failed";
  if (/validation|schema|required|invalid|argument/iu.test(text)) return "input_validation_failed";
  return "tool_execution_failed";
}

function normalizeEvent(
  sessionId: string,
  event: AgentSessionEvent,
  run?: AgentRun,
  context?: PiRunContext,
): PiNormalizedEvent | null {
  const timestamp = new Date().toISOString();
  const runId = run?.id ?? context?.runId;
  const principalId = run?.principalId ?? context?.caller?.principalId;

  switch (event.type) {
    case "agent_start":
      return {
        type: "session_start",
        sessionId,
        timestamp,
        runId,
        principalId,
        data: { runId, principalId },
      };
    case "turn_start":
      return {
        type: "turn_start",
        sessionId,
        timestamp,
        runId,
        principalId,
        data: { runId, principalId },
      };
    case "turn_end":
      return {
        type: "turn_end",
        sessionId,
        timestamp,
        runId,
        principalId,
        data: {
          runId,
          principalId,
          toolResultCount: event.toolResults.length,
          ...(event.message.role === "assistant"
            ? {
                provider: event.message.provider,
                model: event.message.model,
                usage: {
                  inputTokens: event.message.usage.input,
                  outputTokens: event.message.usage.output,
                  cacheReadTokens: event.message.usage.cacheRead,
                  cacheWriteTokens: event.message.usage.cacheWrite,
                  totalTokens: event.message.usage.totalTokens,
                },
              }
            : {}),
        },
      };
    case "tool_execution_start": {
      const input = safeToolInput(event.toolName, event.args);
      return {
        type: "tool_call",
        sessionId,
        timestamp,
        runId,
        principalId,
        toolCallId: event.toolCallId,
        data: {
          runId,
          principalId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          ...(input ? { input } : {}),
        },
      };
    }
    case "tool_execution_end":
      return {
        type: "tool_result",
        sessionId,
        timestamp,
        runId,
        principalId,
        toolCallId: event.toolCallId,
        data: {
          runId,
          principalId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          ...(event.isError ? { failureCode: safeToolFailureCode(event.result) } : {}),
        },
      };
    case "message_update": {
      const update = event.assistantMessageEvent as { type?: string; delta?: string };
      if (update.type !== "text_delta" || typeof update.delta !== "string") return null;
      return {
        type: "message_chunk",
        sessionId,
        timestamp,
        runId,
        principalId,
        data: { runId, principalId, text: update.delta },
      };
    }
    case "agent_end":
      return {
        type: "session_end",
        sessionId,
        timestamp,
        runId,
        principalId,
        data: { runId, principalId, willRetry: event.willRetry },
      };
    default:
      return null;
  }
}

export class PiSdkRuntimeAdapter implements PiRuntimeAdapter {
  private readonly loader: KitLoader;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly runContexts = new Map<string, PiRunContext>();
  private initialized = false;

  constructor(private readonly options: PiSdkRuntimeOptions = {}) {
    this.loader = new KitLoader(options.kitPath);
  }

  async initialize(): Promise<void> {
    const compatibility = this.loader.verifyCompatibility(VERSION);
    if (!compatibility.compatible) {
      throw new Error(`Incompatible Lora PI Kit: ${JSON.stringify(compatibility.details)}`);
    }
    assertProfileSelectionComplete(this.loader.profileNames());
    this.initialized = true;
  }

  async createOrRestoreSession(
    conversation: Conversation,
    profileName: PiRuntimeProfileName,
    context?: PiRunContext,
  ): Promise<PiSessionBinding> {
    if (!this.initialized) throw new Error("Pi runtime is not initialized");

    const profile = this.loader.loadProfile(profileName);
    const config = this.loader.buildRuntimeConfig(profileName, this.options.runtimeBaseDir);
    const resolvedSkills =
      context && this.options.resolveSkillNames
        ? await this.options.resolveSkillNames(context, profile)
        : // No resolver means no channel policy was resolved, so the Kit profile speaks for
          // itself. It is never reached for a Run that has a Principal: the application always
          // supplies a resolver, and a Run without one denies through `no-caller`.
          kitProfileSkillVisibility(profile);
    const authorizedSkillNames = [...new Set(resolvedSkills.names)];
    const modelVisibleSkillNames = [
      ...new Set(resolvedSkills.modelVisibleNames ?? authorizedSkillNames),
    ];
    if (context) {
      context.authorizedSkillNames = authorizedSkillNames;
      context.modelVisibleSkillNames = modelVisibleSkillNames;
      context.skillPolicy = structuredClone(resolvedSkills.policy ?? { source: "kit-profile" });
    }
    const effectiveProfile = { ...profile, enabledSkills: authorizedSkillNames };
    const runtimeEvidence = this.loader.runtimeEvidence(profileName, authorizedSkillNames);
    const candidates =
      context && this.options.resolveToolCandidates
        ? await this.options.resolveToolCandidates(context)
        : undefined;
    const authorizedToolNames = candidates
      ? candidates
          .filter((candidate) => candidate.exclusion === null)
          .map((candidate) => candidate.name)
      : context && this.options.resolveToolNames
        ? [...new Set(await this.options.resolveToolNames(context))]
        : undefined;
    // The effective surface is built here, where the Kit profile and the discovery result
    // meet. It is evidence about this Run, so it is recorded rather than recomputed later
    // from newer state.
    const toolSurface = candidates
      ? describeToolSurface({
          profileName,
          profileActiveTools: profile.activeTools,
          candidates,
          // The digest of the profile file that produced this surface, so an old Run's
          // evidence can be read against the declaration it actually ran under.
          profileVersion: profileFingerprint(runtimeEvidence, profileName),
        })
      : undefined;
    // Hand the resolved surface back on the Run context. The execution adapter binds a
    // required Tool only when the surface carries it, so discovery and the requirement can
    // never disagree about which Tools this Run has.
    if (context) context.authorizedToolNames = authorizedToolNames ?? [];
    await mkdir(config.agentDir, { recursive: true });
    const sessionDir = path.join(config.agentDir, "sessions", conversation.id);
    await mkdir(sessionDir, { recursive: true });
    const session = this.options.createSession
      ? await this.options.createSession({
          conversation,
          profile: effectiveProfile,
          agentDir: config.agentDir,
          sessionDir,
          modelVisibleSkillNames,
        })
      : await this.createRealSession(
          effectiveProfile,
          config.agentDir,
          sessionDir,
          authorizedToolNames,
          modelVisibleSkillNames,
        );
    const now = new Date().toISOString();
    const binding: PiSessionBinding = {
      conversationId: conversation.id,
      runtimeSessionId: session.sessionId,
      profileName,
      agentDir: config.agentDir,
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(session.sessionId, {
      session,
      binding,
      runtimeEvidence,
      authorizedToolNames: authorizedToolNames ?? [],
      toolSurface,
      authorizedSkillNames,
      modelVisibleSkillNames,
      skillPolicy: structuredClone(resolvedSkills.policy ?? { source: "kit-profile" }),
    });
    return { ...binding };
  }

  private async createRealSession(
    profile: ResolvedKitProfile,
    agentDir: string,
    sessionDir: string,
    authorizedToolNames?: readonly string[],
    modelVisibleSkillNames?: readonly string[],
  ): Promise<ActiveSession["session"]> {
    const kitPath = this.loader.getKitPath();
    const cwd = this.options.cwd ?? process.cwd();
    const settingsManager = SettingsManager.inMemory();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(profile.promptTemplate))
      throw new Error("Invalid Kit prompt template");
    const basePrompt = glassboxSystemPrompt(
      this.loader.modelPrompt(profile.name, modelVisibleSkillNames ?? []),
    );
    let runtimeSessionId: string | undefined;
    const promptForRun = () => {
      const runContext = runtimeSessionId ? this.runContexts.get(runtimeSessionId) : undefined;
      const requiredToolName = runContext?.requiredToolName;
      const exactInput = requiredInputClause(runContext?.requiredToolInput);
      // The requirement is read from the current message, not from the Tool surface this Run
      // resolved, so this sentence never claims the Tool is on the surface: a Run that cannot
      // call it fails closed below the model instead of answering on its behalf.
      const required = requiredToolName
        ? `${basePrompt}\n\nThe current request requires the ${requiredToolName} tool. Call it before reporting the action as completed${exactInput}. Do not ask for a second confirmation and never claim execution without a successful tool result.`
        : basePrompt;
      // The Tool the Runtime requires for a factual answer. This sentence guides the model; it
      // is not the requirement. A Run that answers without the call fails closed below the
      // model either way, so this only decides whether the Run can still answer honestly.
      const evidenceTools = [
        ...new Set((runContext?.requiredEvidence ?? []).map((evidence) => evidence.tool)),
      ];
      return evidenceTools.length === 0
        ? required
        : `${required}\n\nThe current request asks for facts that only QQ can report. Call ${evidenceTools.join(" and ")} and answer from its result. If the call does not succeed, say the information could not be confirmed. Never answer from what the request itself says, from earlier Conversation, or from what you expect the tool to return.`;
    };
    // Standalone Kit MCP factories are configured separately. Glassbox exposes
    // only explicitly registered product-authorized Tools, never ambient servers.
    if (
      profile.enabledExtensions.includes("mcp/tool-adapter") &&
      profile.enabledMcpServers.length > 0
    )
      throw new Error("Glassbox MCP servers require an authorized Tool registration");
    const extensionPaths = profile.enabledExtensions
      .filter((name) => name !== "mcp/tool-adapter")
      .map((name) => path.join(kitPath, "extensions", `${name}.ts`));
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: extensionPaths,
      // Pi appends its host cwd even to a custom system prompt. Replace that
      // assembled prompt through the public event before the provider sees it.
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", () => ({ systemPrompt: promptForRun() }));
        },
      ],
      additionalSkillPaths: [path.join(kitPath, "skills")],
      additionalPromptTemplatePaths: [path.join(kitPath, "prompts")],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => basePrompt,
      skillsOverride: (current) => ({
        ...current,
        skills: current.skills.filter((skill) => profile.enabledSkills.includes(skill.name)),
      }),
    });
    await resourceLoader.reload();
    if (resourceLoader.getExtensions().errors.length > 0)
      throw new Error("Kit extension loading failed");
    void sessionDir;
    const sessionManager = SessionManager.inMemory(cwd);
    const customTools =
      this.options.createTools?.(() =>
        runtimeSessionId ? this.runContexts.get(runtimeSessionId) : undefined,
      ) ??
      this.options.customTools ??
      [];
    const selectedNames = authorizedToolNames ? new Set(authorizedToolNames) : undefined;
    const selectedTools = selectedNames
      ? customTools.filter((tool) => selectedNames.has(tool.name))
      : customTools;
    const customToolNames = selectedTools.map((tool) => tool.name);
    const tools = Array.from(new Set(customToolNames));
    const configured = await this.options.resolveModel?.();
    const created = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager,
      settingsManager,
      model: configured?.model ?? this.options.model,
      modelRuntime: configured?.modelRuntime ?? this.options.modelRuntime,
      noTools: "all",
      tools,
      excludeTools: [...GLASSBOX_HOST_EXCLUDED_PI_TOOLS],
      customTools: selectedTools,
      thinkingLevel: profile.thinkingLevel === "none" ? "minimal" : profile.thinkingLevel,
    });
    runtimeSessionId = created.session.sessionId;
    await created.session.bindExtensions({});
    created.session.setActiveToolsByName(customToolNames);
    return created.session;
  }

  getRunContext(runtimeSessionId: string): PiRunContext | undefined {
    return this.runContexts.get(runtimeSessionId);
  }

  async run(
    binding: PiSessionBinding,
    run: AgentRun,
    prompt: string,
    context?: PiRunContext,
  ): Promise<PiRunResult> {
    const active = this.sessions.get(binding.runtimeSessionId);
    if (!active || active.binding.conversationId !== binding.conversationId) {
      throw new Error("Pi session binding is not active for this Conversation");
    }
    if (
      run.conversationId !== binding.conversationId ||
      (context?.runId !== undefined && context.runId !== run.id) ||
      (context?.conversationId !== undefined && context.conversationId !== run.conversationId) ||
      (context?.caller !== undefined && context.caller.principalId !== run.principalId)
    ) {
      throw new Error("Pi Run identity mismatch");
    }
    if (context) {
      this.runContexts.set(binding.runtimeSessionId, context);
    }
    const toolCalls: PiRunResult["toolCalls"] = [];
    let text = "";
    let eventQueue = Promise.resolve();
    let evidenceFailed = false;

    const unsubscribe = active.session.subscribe((event) => {
      const normalized = normalizeEvent(active.session.sessionId, event, run, context);
      if (normalized?.type === "session_start") {
        normalized.data = {
          ...normalized.data,
          conversationId: run.conversationId,
          runtime: active.runtimeEvidence,
          authorizedTools: active.authorizedToolNames,
          // The classified surface, when discovery reported one. Absent for a fake that only
          // supplies names, and never fabricated here — a missing surface is a fact too.
          ...(active.toolSurface ? { toolSurface: active.toolSurface } : {}),
          authorizedSkills: active.authorizedSkillNames,
          modelVisibleSkills: active.modelVisibleSkillNames,
          skillPolicy: active.skillPolicy,
        };
      }
      if (normalized && this.options.onEvent) {
        eventQueue = eventQueue.then(async () => {
          try {
            await this.options.onEvent?.(normalized);
          } catch {
            evidenceFailed = true;
          }
        });
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent as { type?: string; delta?: string };
        if (update.type === "text_delta" && typeof update.delta === "string") text += update.delta;
      } else if (event.type === "tool_execution_start") {
        toolCalls.push({
          name: event.toolName,
          input: event.args as Record<string, unknown>,
          toolCallId: event.toolCallId,
        });
      } else if (event.type === "tool_execution_end") {
        // Match on the runtime's own call id when it gives one: a Run may call the same Tool
        // more than once, and a result attributed to the wrong call would credit evidence to
        // a call that never produced it.
        const call = [...toolCalls]
          .reverse()
          .find((candidate) =>
            candidate.toolCallId === undefined
              ? candidate.name === event.toolName && candidate.failed === undefined
              : candidate.toolCallId === event.toolCallId && candidate.failed === undefined,
          );
        if (call) {
          call.result = event.result;
          call.failed = event.isError;
          call.outcome = event.isError
            ? toolOutcomeFromFailure(safeToolFailureCode(event.result))
            : "success";
        }
      }
    });
    try {
      await active.session.prompt(prompt, { source: "rpc" });
      await eventQueue;
      if (evidenceFailed)
        return { status: "error", text: "", toolCalls: [], error: "trace_write_failed" };
      const last = [...active.session.messages]
        .reverse()
        .find((message) => (message as { role?: string }).role === "assistant") as
        | {
            content?: unknown;
            usage?: { input?: number; output?: number; totalTokens?: number };
            stopReason?: string;
            errorMessage?: string;
          }
        | undefined;
      if (last) text = textFromContent(last.content);
      active.binding.lastActiveAt = new Date().toISOString();
      return {
        status:
          last?.stopReason === "error"
            ? "error"
            : last?.stopReason === "aborted"
              ? "aborted"
              : "completed",
        text,
        toolCalls,
        usage: last?.usage
          ? {
              inputTokens: last.usage.input,
              outputTokens: last.usage.output,
              totalTokens: last.usage.totalTokens,
            }
          : undefined,
        error: last?.errorMessage,
      };
    } catch (error) {
      return {
        status: "error",
        text,
        toolCalls,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      unsubscribe();
      await eventQueue;
      try {
        if (context) await this.options.onRunEnd?.(context);
      } finally {
        this.runContexts.delete(binding.runtimeSessionId);
      }
    }
  }

  async abort(runtimeSessionId: string): Promise<void> {
    const active = this.sessions.get(runtimeSessionId);
    if (active) await active.session.abort();
  }

  async disposeSession(runtimeSessionId: string): Promise<void> {
    const active = this.sessions.get(runtimeSessionId);
    if (active) {
      try {
        await active.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        active.session.dispose();
        this.sessions.delete(runtimeSessionId);
        this.runContexts.delete(runtimeSessionId);
      }
    }
  }

  async cleanup(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.disposeSession(id)),
    );
    this.runContexts.clear();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
