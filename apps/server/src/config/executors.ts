import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { ClaudeExecutorSettings, PublicExecutor } from "@glassbox/contracts";
import {
  createClaudeHarnessAdapter,
  executableSha256,
  type ClaudeCredentialEnvironment,
} from "../execution/harness/index.js";
import type { ExecutionInput, RunExecutionAdapter } from "../execution/run-service/types.js";
import type { HarnessEvent } from "../execution/harness/types.js";
import { resolveClaudeExecutable } from "../platform/executable.js";
import { scopeKey } from "../identity/scope.js";
import { ConfigurationError, type ModelProfileStore } from "./model-profiles.js";

interface State {
  version: 1;
  settings: ClaudeExecutorSettings;
  proof: { executableSha256: string; checkedAt: string } | null;
}
interface Connection {
  credentials: ClaudeCredentialEnvironment;
  apiBaseUrl?: string;
  model?: string;
}
interface ExecutorOptions {
  dataDirectory: string;
  models: ModelProfileStore;
  localConfigDirectory?: string;
  onEvent?(event: HarnessEvent): void | Promise<void>;
}
export class ExecutorBusyError extends ConfigurationError {
  constructor() {
    super("An executor check is already running");
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConfigurationError("Invalid executor configuration");
  return value as Record<string, unknown>;
}
function parseSettings(input: unknown): ClaudeExecutorSettings {
  const value = object(input);
  if (
    Object.keys(value).some(
      (key) => !["id", "credentialSource", "modelProfileId", "model"].includes(key),
    ) ||
    value.id !== "claude-code" ||
    !["local-claude", "model-profile"].includes(String(value.credentialSource))
  )
    throw new ConfigurationError("Invalid executor configuration");
  if (
    value.model != null &&
    (typeof value.model !== "string" || !/^[^\r\n\0]{1,256}$/u.test(value.model))
  )
    throw new ConfigurationError("Invalid executor model");
  if (
    value.credentialSource === "model-profile" &&
    (typeof value.modelProfileId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value.modelProfileId))
  )
    throw new ConfigurationError("Select an Anthropic model profile");
  return {
    id: "claude-code",
    credentialSource: value.credentialSource as ClaudeExecutorSettings["credentialSource"],
    modelProfileId:
      value.credentialSource === "model-profile" ? String(value.modelProfileId) : null,
    model: typeof value.model === "string" ? value.model : null,
  };
}
async function boundedJson(file: string): Promise<Record<string, unknown>> {
  if ((await stat(file)).size > 1024 * 1024)
    throw new ConfigurationError("Executor configuration exceeds the size limit");
  try {
    return object(JSON.parse(await readFile(file, "utf8")));
  } catch {
    throw new ConfigurationError("Executor configuration cannot be read");
  }
}

/** Reads only authentication and endpoint/model fields. Hooks, skills and permissions are never applied. */
export async function localClaudeConnection(
  configDirectory = join(homedir(), ".claude"),
): Promise<Connection> {
  if (!isAbsolute(configDirectory))
    throw new ConfigurationError("Claude configuration directory must be absolute");
  let settings: Record<string, unknown> = {};
  try {
    settings = await boundedJson(join(configDirectory, "settings.json"));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const env = settings.env === undefined ? {} : object(settings.env);
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
  const present = keys.filter((key) => typeof env[key] === "string" && env[key] !== "");
  const apiBaseUrl =
    typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : undefined;
  const model = typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL : undefined;
  if (present.length === 1)
    return { credentials: { [present[0]!]: env[present[0]!] as string }, apiBaseUrl, model };
  if (present.length > 1)
    throw new ConfigurationError("Claude has more than one credential source");
  const oauth = object(
    (await boundedJson(join(configDirectory, ".credentials.json"))).claudeAiOauth,
  );
  if (
    typeof oauth.accessToken !== "string" ||
    typeof oauth.expiresAt !== "number" ||
    oauth.expiresAt <= Date.now()
  )
    throw new ConfigurationError("Claude login is unavailable or expired");
  // OAuth belongs to the native Anthropic endpoint, never to an unrelated settings override.
  if (apiBaseUrl) throw new ConfigurationError("OAuth login cannot use a custom endpoint");
  return { credentials: { CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken }, model };
}

export class ExecutorConfiguration {
  private tail: Promise<unknown> = Promise.resolve();
  private lastCheck: PublicExecutor["lastCheck"] = null;
  private readonly active = new Set<string>();
  private checking = false;
  private constructor(
    private readonly options: {
      dataDirectory: string;
      models: ModelProfileStore;
      localConfigDirectory?: string;
      onEvent?(event: HarnessEvent): void | Promise<void>;
    },
    private state: State,
  ) {}

  static async open(options: ExecutorOptions) {
    let state: State = {
      version: 1,
      settings: {
        id: "claude-code",
        credentialSource: "local-claude",
        modelProfileId: null,
        model: null,
      },
      proof: null,
    };
    try {
      const value = await boundedJson(join(options.dataDirectory, "executors.json"));
      if (value.version !== 1) throw new ConfigurationError("Unsupported executor settings");
      state = { version: 1, settings: parseSettings(value.settings), proof: null };
      if (value.proof != null) {
        const proof = object(value.proof);
        if (
          typeof proof.executableSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(proof.executableSha256) ||
          typeof proof.checkedAt !== "string" ||
          !Number.isFinite(Date.parse(proof.checkedAt))
        )
          throw new ConfigurationError("Invalid executor check evidence");
        state.proof = { executableSha256: proof.executableSha256, checkedAt: proof.checkedAt };
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    const configuration = new ExecutorConfiguration(options, state);
    await configuration.list();
    return configuration;
  }
  async list(): Promise<PublicExecutor[]> {
    const executable = resolveClaudeExecutable();
    const proof = this.state.proof;
    if (
      proof &&
      (!executable ||
        (await executableSha256(executable).catch(() => "")) !== proof.executableSha256)
    ) {
      this.state = { ...this.state, proof: null };
      this.lastCheck = {
        status: "failed",
        checkedAt: new Date().toISOString(),
        code: "EXECUTABLE_CHANGED",
      };
    }
    return [
      {
        ...this.state.settings,
        executableDetected: Boolean(executable),
        groupSupported: this.state.proof !== null,
        checking: this.checking,
        tools: "none",
        lastCheck:
          this.lastCheck ??
          (this.state.proof ? { status: "passed", checkedAt: this.state.proof.checkedAt } : null),
      },
    ];
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.tail.catch(() => undefined).then(operation);
    this.tail = current;
    return current;
  }
  private async persist(state: State) {
    const directory = this.options.dataDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.executors-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(state, null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(directory, "executors.json"));
      this.state = state;
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new ConfigurationError("Executor settings could not be saved");
    }
  }
  save(input: unknown): Promise<PublicExecutor> {
    if (this.checking) return Promise.reject(new ExecutorBusyError());
    const settings = parseSettings(input);
    return this.serialized(async () => {
      if (
        settings.modelProfileId &&
        this.options.models.resolve(settings.modelProfileId).profile.protocol !==
          "anthropic-messages"
      )
        throw new ConfigurationError("Claude Code requires an Anthropic model profile");
      await this.persist({ version: 1, settings, proof: null });
      this.lastCheck = null;
      return (await this.list())[0]!;
    });
  }
  private async connection(settings: ClaudeExecutorSettings): Promise<Connection> {
    const source = settings.modelProfileId
      ? (() => {
          const { profile, apiKey } = this.options.models.resolve(settings.modelProfileId);
          if (profile.protocol !== "anthropic-messages" || !apiKey)
            throw new ConfigurationError("An Anthropic profile with a credential is required");
          return {
            credentials: { ANTHROPIC_API_KEY: apiKey },
            apiBaseUrl: profile.baseUrl,
            model: profile.model,
          };
        })()
      : await localClaudeConnection(this.options.localConfigDirectory);
    return { ...source, ...(settings.model ? { model: settings.model } : {}) };
  }
  adapter(): RunExecutionAdapter {
    const groupSupported = () => this.state.proof !== null;
    return {
      get supportsGroup() {
        return groupSupported();
      },
      execute: async (input) => {
        const key = JSON.stringify([
          input.caller.principalId,
          scopeKey(input.caller.scope),
          input.conversation.id,
        ]);
        if (this.active.has(key)) return { status: "unknown" };
        this.active.add(key);
        let release = true;
        try {
          const { settings, proof } = structuredClone(this.state);
          const executablePath = resolveClaudeExecutable();
          if (!executablePath) return { status: "failed" };
          const connection = await this.connection(settings);
          const result = await createClaudeHarnessAdapter({
            dataDirectory: this.options.dataDirectory,
            executionRef: "claude-code",
            executablePath,
            credentials: async () => connection.credentials,
            apiBaseUrl: connection.apiBaseUrl,
            model: connection.model,
            hostEnvironment: { SystemRoot: process.env.SystemRoot },
            onEvent: (event) => this.options.onEvent?.(event),
            ...(proof
              ? {
                  groupIsolation: {
                    executableSha256: proof.executableSha256,
                    toolMode: "none" as const,
                  },
                }
              : {}),
          }).execute(input);
          release = result.status !== "unknown";
          return result;
        } finally {
          if (release) this.active.delete(key);
        }
      },
    };
  }
  check(): Promise<PublicExecutor> {
    if (this.checking) return Promise.reject(new ExecutorBusyError());
    this.checking = true;
    return this.serialized(async () => {
      const checkedAt = new Date().toISOString();
      await this.persist({ ...this.state, proof: null });
      try {
        const executablePath = resolveClaudeExecutable();
        if (!executablePath) throw new ConfigurationError("Installed Claude is missing");
        const beforeHash = await executableSha256(executablePath);
        const connection = await this.connection(this.state.settings);
        const dataDirectory = await mkdtemp(join(tmpdir(), "glassbox-executor-check-"));
        const id = randomUUID();
        const scope = {
          connectionId: "local-check",
          botId: "local",
          chatType: "private" as const,
          chatId: id,
          senderId: "owner",
        };
        const input: ExecutionInput = {
          caller: { principalId: "owner", scope },
          conversation: {
            id,
            agentId: "personal",
            principalId: "owner",
            scope,
            providerKind: null,
            providerSessionId: null,
            createdAt: checkedAt,
          },
          run: {
            id,
            conversationId: id,
            messageId: id,
            executionRef: "claude-code",
            status: "running",
            resultText: null,
            createdAt: checkedAt,
            updatedAt: checkedAt,
          },
          history: [],
          text: "Reply with exactly GLASSBOX_EXECUTOR_OK and nothing else.",
          providerSessionId: null,
          signal: new AbortController().signal,
        };
        const result = await createClaudeHarnessAdapter({
          dataDirectory,
          executionRef: "claude-code",
          executablePath,
          credentials: async () => connection.credentials,
          apiBaseUrl: connection.apiBaseUrl,
          model: connection.model,
          hostEnvironment: { SystemRoot: process.env.SystemRoot },
          executionTimeoutMs: 90_000,
        }).execute(input);
        if (result.status !== "succeeded" || result.text?.trim() !== "GLASSBOX_EXECUTOR_OK")
          throw new ConfigurationError("Executor check did not complete");
        const afterHash = await executableSha256(executablePath);
        if (beforeHash !== afterHash)
          throw new ConfigurationError("Installed Claude changed during its check");
        await this.persist({
          ...this.state,
          proof: { executableSha256: afterHash, checkedAt },
        });
        this.lastCheck = { status: "passed", checkedAt };
      } catch {
        this.lastCheck = { status: "failed", checkedAt, code: "EXECUTOR_CHECK_FAILED" };
      }
      return { ...(await this.list())[0]!, checking: false };
    }).finally(() => {
      this.checking = false;
    });
  }
}
