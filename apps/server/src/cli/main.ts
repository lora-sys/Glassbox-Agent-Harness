import type { Readable } from "node:stream";
import { CliError, hasControlCharacters, type CliErrorCode } from "./errors.ts";
import { runCli } from "./run.ts";
import type { CliDependencies } from "./run.ts";

export interface SecretInput extends Readable {
  isTTY?: boolean;
}

async function readPrivateStdin(
  input: SecretInput,
  timeoutMs: number,
  kind: "secret" | "json",
): Promise<string> {
  const limit = kind === "secret" ? 16384 : 64 * 1024;
  const required = kind === "secret" ? "SECRET_REQUIRED" : "INPUT_REQUIRED";
  const tooLarge = kind === "secret" ? "SECRET_TOO_LARGE" : "INPUT_TOO_LARGE";
  const timeout = kind === "secret" ? "SECRET_TIMEOUT" : "INPUT_TIMEOUT";
  if (input.isTTY) throw new CliError(required);
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onClose);
      input.pause();
    };
    const fail = (code: CliErrorCode) => {
      cleanup();
      reject(new CliError(code));
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      bytes += buffer.byteLength;
      if (bytes > limit + 2) {
        fail(tooLarge);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try {
        const text = new TextDecoder("utf-8", { fatal: true })
          .decode(Buffer.concat(chunks, bytes))
          .trim();
        if (Buffer.byteLength(text, "utf8") > limit) {
          reject(new CliError(tooLarge));
          return;
        }
        if (!text || (kind === "secret" && hasControlCharacters(text))) throw new Error();
        resolve(text);
      } catch {
        reject(new CliError(required));
      }
    };
    const onError = () => fail(required);
    const onClose = () => fail(required);
    const timer = setTimeout(() => fail(timeout), timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
    if (input.readableEnded || input.destroyed) fail(required);
  });
}

export function readSecretFromStdin(
  input: SecretInput = process.stdin,
  timeoutMs = 30_000,
): Promise<string> {
  return readPrivateStdin(input, timeoutMs, "secret");
}

export function readJsonFromStdin(
  input: SecretInput = process.stdin,
  timeoutMs = 30_000,
): Promise<string> {
  return readPrivateStdin(input, timeoutMs, "json");
}

export type MainDependencies = Pick<
  CliDependencies,
  "resolveConnection" | "startServer" | "clientOptions"
> &
  Partial<Pick<CliDependencies, "readSecret" | "readInput" | "stdout" | "stderr">>;

/** The application entrypoint supplies its existing service startup and token resolver. */
export function main(args: readonly string[], dependencies: MainDependencies): Promise<number> {
  return runCli(args, {
    ...dependencies,
    readSecret: dependencies.readSecret ?? readSecretFromStdin,
    readInput: dependencies.readInput ?? readJsonFromStdin,
    stdout:
      dependencies.stdout ??
      ((text) => {
        process.stdout.write(text);
      }),
    stderr:
      dependencies.stderr ??
      ((text) => {
        process.stderr.write(text);
      }),
  });
}
