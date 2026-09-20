import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentRun, Conversation } from "@glassbox/contracts";
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
  resolveSkillNames?: (
    context: PiRunContext,
    profile: ResolvedKitProfile,
  ) => Promise<{
    names: readonly string[];
    modelVisibleNames?: readonly string[];
    policy?: Record<string, unknown>;
  }>;
  resolveToolNames?: (context: PiRunContext) => Promise<readonly string[]>;
  onEvent?: (event: PiNormalizedEvent) => void | Promise<void>;
  createSession?: (params: {
    conversation: Conversation;
    profile: ResolvedKitProfile;
    agentDir: string;
    sessionDir: string;
    modelVisibleSkillNames?: readonly string[];
  }) => Promise<ActiveSession["session"]>;
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

function safeToolInput(toolName: string, args: unknown): Record<string, unknown> | undefined {
  if (toolName !== "owner_group_admin" || !args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
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
        : {
            names: profile.enabledSkills,
            modelVisibleNames: profileName === "main-agent" ? [] : profile.enabledSkills,
            policy: { source: "kit-profile" },
          };
    const authorizedSkillNames = [...new Set(resolvedSkills.names)];
    const modelVisibleSkillNames = [
      ...new Set(
        resolvedSkills.modelVisibleNames ??
          (profileName === "main-agent" ? [] : authorizedSkillNames),
      ),
    ];
    if (context) {
      context.authorizedSkillNames = authorizedSkillNames;
      context.modelVisibleSkillNames = modelVisibleSkillNames;
      context.skillPolicy = structuredClone(resolvedSkills.policy ?? { source: "kit-profile" });
    }
    const effectiveProfile = { ...profile, enabledSkills: authorizedSkillNames };
    const runtimeEvidence = this.loader.runtimeEvidence(profileName, authorizedSkillNames);
    const authorizedToolNames =
      context && this.options.resolveToolNames
        ? [...new Set(await this.options.resolveToolNames(context))]
        : undefined;
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
    const basePrompt = `${this.loader.modelPrompt(profile.name, modelVisibleSkillNames ?? []).trim()}\n\nReply in concise plain text suitable for QQ. Do not reveal host paths, internal service addresses, configuration names, or internal identifiers.`;
    let runtimeSessionId: string | undefined;
    const promptForRun = () => {
      const runContext = runtimeSessionId ? this.runContexts.get(runtimeSessionId) : undefined;
      const requiredToolName = runContext?.requiredToolName;
      const exactInput = runContext?.requiredToolInput
        ? ` with exactly this JSON input: ${JSON.stringify(runContext.requiredToolInput)}`
        : "";
      return requiredToolName
        ? `${basePrompt}\n\nThe current Owner request requires the available ${requiredToolName} tool. Call it before reporting the action as completed${exactInput}. Do not ask for a second confirmation and never claim execution without a successful tool result.`
        : basePrompt;
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
      excludeTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"],
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
        toolCalls.push({ name: event.toolName, input: event.args as Record<string, unknown> });
      } else if (event.type === "tool_execution_end") {
        const call = [...toolCalls]
          .reverse()
          .find((candidate) => candidate.name === event.toolName && candidate.failed === undefined);
        if (call) {
          call.result = event.result;
          call.failed = event.isError;
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
      this.runContexts.delete(binding.runtimeSessionId);
      await eventQueue;
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
