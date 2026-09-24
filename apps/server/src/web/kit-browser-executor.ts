import { randomUUID } from "node:crypto";
import type { BrowserArtifactStore } from "./browser-artifact-store.js";
import type { BrowserSessionBinding } from "./browser-session.js";
import type {
  BrowserExecutionSession,
  BrowserExecutorLimits,
  BrowserExecutorPort,
  BrowserExecutorResult,
} from "./browser-executor-port.js";

export interface KitCliResult {
  content: unknown[];
  details?: unknown;
  isError?: boolean;
}

export interface KitCliSession {
  executeCli(input: {
    id: string;
    executable: "agent-browser";
    args: string[];
    maxArtifactBytes?: number;
  }): Promise<KitCliResult>;
  cancel(id: string): Promise<void>;
  closeRun(): Promise<void>;
}

type KitSessionLookup = (binding: BrowserSessionBinding) => Promise<KitCliSession | undefined>;

const SESSION_ID = /^gb-[a-f0-9]{24}$/u;
const CALL_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_CHARS = 4_096;
const MAX_KIT_ARTIFACT_BYTES = 2 * 1024 * 1024;

function validateArgs(args: readonly string[], sessionId: string): string[] {
  if (
    args.length < 4 ||
    args.length > MAX_ARGUMENTS ||
    args.some(
      (arg) => typeof arg !== "string" || arg.length > MAX_ARGUMENT_CHARS || arg.includes("\0"),
    ) ||
    args[0] !== "--json" ||
    args[1] !== "--session" ||
    args[2] !== sessionId
  )
    throw new Error("browser_invalid_argv");
  return [...args];
}

function validateLimits(limits: BrowserExecutorLimits): void {
  if (
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs < 1 ||
    !Number.isSafeInteger(limits.maxOutputChars) ||
    limits.maxOutputChars < 0 ||
    !Number.isSafeInteger(limits.maxArtifactBytes) ||
    limits.maxArtifactBytes < 1
  )
    throw new Error("browser_invalid_limits");
}

function structuredResult(
  value: KitCliResult,
  maxOutputChars: number,
  screenshot: boolean,
  maxArtifactBytes: number,
): { result: BrowserExecutorResult; base64Png?: string } {
  if (
    !value ||
    !Array.isArray(value.content) ||
    !value.content.every(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (((block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string") ||
          ((block as { type?: unknown }).type === "image" &&
            typeof (block as { data?: unknown }).data === "string" &&
            typeof (block as { mimeType?: unknown }).mimeType === "string")),
    ) ||
    (value.isError !== undefined && typeof value.isError !== "boolean") ||
    !value.details ||
    typeof value.details !== "object" ||
    Array.isArray(value.details)
  )
    throw new Error("browser_cli_result_invalid");
  const details = value.details as Record<string, unknown>;
  if (
    !Number.isSafeInteger(details.exitCode) ||
    (details.exitCode as number) < 0 ||
    (details.exitCode as number) > 255 ||
    typeof details.stdout !== "string" ||
    typeof details.stderr !== "string"
  )
    throw new Error("browser_cli_result_invalid");
  if (Object.hasOwn(value, "artifact")) throw new Error("browser_cli_result_invalid");
  const hasArtifact = Object.hasOwn(details, "artifact");
  if (screenshot !== hasArtifact) throw new Error("browser_cli_result_invalid");
  let base64Png: string | undefined;
  if (hasArtifact) {
    const artifact = details.artifact;
    if (
      !artifact ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      Object.keys(artifact).sort().join(",") !== "data,mimeType,sizeBytes"
    )
      throw new Error("browser_cli_result_invalid");
    const payload = artifact as Record<string, unknown>;
    if (
      payload.mimeType !== "image/png" ||
      typeof payload.data !== "string" ||
      payload.data.length > Math.ceil(maxArtifactBytes / 3) * 4 ||
      !Number.isSafeInteger(payload.sizeBytes) ||
      (payload.sizeBytes as number) <= 0 ||
      (payload.sizeBytes as number) > maxArtifactBytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload.data)
    )
      throw new Error("browser_cli_result_invalid");
    const bytes = Buffer.from(payload.data, "base64");
    if (bytes.toString("base64") !== payload.data || bytes.length !== payload.sizeBytes)
      throw new Error("browser_cli_result_invalid");
    base64Png = payload.data;
  }
  return {
    result: {
      exitCode: details.exitCode as number,
      stdout: details.stdout.slice(0, maxOutputChars),
      stderr: details.stderr.slice(0, maxOutputChars),
    },
    ...(base64Png ? { base64Png } : {}),
  };
}

/** Adapts the Run's existing Kit session without opening or closing a sandbox. */
export function createKitBrowserExecutor(
  lookup: KitSessionLookup,
  artifacts: Pick<BrowserArtifactStore, "write">,
): BrowserExecutorPort {
  return {
    async open(binding, sessionId): Promise<BrowserExecutionSession> {
      if (!SESSION_ID.test(sessionId)) throw new Error("browser_invalid_session");
      const kitSession = await lookup(binding);
      if (!kitSession) throw new Error("browser_kit_session_unavailable");

      let closed = false;
      let browserClosed = false;
      const active = new Set<string>();
      const cancellations = new Map<string, Promise<void>>();
      const cancelCall = (id: string): Promise<void> => {
        let cancellation = cancellations.get(id);
        if (!cancellation) {
          cancellation = Promise.resolve()
            .then(() => kitSession.cancel(id))
            .catch(() => {
              throw new Error("browser_cancel_uncertain");
            });
          cancellations.set(id, cancellation);
        }
        return cancellation;
      };
      const cancelActive = async (): Promise<void> => {
        const results = await Promise.allSettled([...active].map(cancelCall));
        if (results.some((result) => result.status === "rejected"))
          throw new Error("browser_cancel_uncertain");
      };

      return {
        async execute(args, limits) {
          if (closed) throw new Error("browser_executor_closed");
          validateLimits(limits);
          const argv = validateArgs(args, sessionId);
          const screenshot = argv[3] === "screenshot";
          const maxArtifactBytes = Math.min(limits.maxArtifactBytes, MAX_KIT_ARTIFACT_BYTES);

          const id = `browser_${randomUUID().replaceAll("-", "")}`;
          if (!CALL_ID.test(id)) throw new Error("browser_call_id_invalid");
          active.add(id);
          let cancellation: Promise<void> | undefined;
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              cancellation = cancelCall(id);
              void cancellation.then(
                () => reject(new Error("browser_timeout")),
                (error: unknown) => reject(error),
              );
            }, limits.timeoutMs);
          });
          try {
            const result = await Promise.race([
              kitSession.executeCli({
                id,
                executable: "agent-browser",
                args: argv,
                ...(screenshot ? { maxArtifactBytes } : {}),
              }),
              timeout,
            ]);
            cancellation ??= cancellations.get(id);
            if (cancellation) {
              await cancellation;
              if (timedOut) throw new Error("browser_timeout");
              throw new Error("browser_cancelled");
            }
            const parsed = structuredResult(
              result,
              limits.maxOutputChars,
              screenshot,
              maxArtifactBytes,
            );
            if (argv[3] === "close" && parsed.result.exitCode === 0) {
              try {
                browserClosed = JSON.parse(parsed.result.stdout)?.success === true;
              } catch {
                browserClosed = false;
              }
            }
            if (parsed.result.exitCode !== 0 || !parsed.base64Png) return parsed.result;
            const artifact = await artifacts.write(binding, parsed.base64Png, maxArtifactBytes);
            return { ...parsed.result, artifact };
          } catch (error) {
            cancellation ??= cancellations.get(id);
            if (cancellation) {
              await cancellation;
              if (timedOut) throw new Error("browser_timeout");
            }
            throw error;
          } finally {
            if (timer) clearTimeout(timer);
            active.delete(id);
            cancellations.delete(id);
          }
        },
        async cancel() {
          await cancelActive();
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            if (active.size > 0) await cancelActive();
            if (!browserClosed) {
              const id = `browser_${randomUUID().replaceAll("-", "")}`;
              const result = await kitSession.executeCli({
                id,
                executable: "agent-browser",
                args: ["--json", "--session", sessionId, "close"],
              });
              const parsed = structuredResult(result, 4_096, false, 0).result;
              if (parsed.exitCode !== 0 || JSON.parse(parsed.stdout)?.success !== true)
                throw new Error("browser_cleanup_failed");
            }
          } catch {
            await kitSession.closeRun();
            throw new Error("browser_cleanup_uncertain");
          }
        },
      };
    },
  };
}
