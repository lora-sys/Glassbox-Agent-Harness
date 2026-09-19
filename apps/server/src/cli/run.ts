import { createManagementClient } from "./client.ts";
import type { ManagementClientOptions, ManagementConnection } from "./client.ts";
import { CLI_HELP, parseCommand } from "./commands.ts";
import { CliError, hasControlCharacters, isRecord } from "./errors.ts";
import { publicOutput } from "./output.ts";
import { parseChannelInput } from "./channel-input.ts";

export interface CliDependencies {
  resolveConnection(): Promise<ManagementConnection>;
  startServer?(): Promise<unknown>;
  readSecret?(): Promise<string>;
  readInput?(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  clientOptions?: ManagementClientOptions;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  let json = args.includes("--json");
  try {
    const command = parseCommand(args);
    json = command.json;
    if (command.kind === "help") {
      dependencies.stdout(
        json ? `${JSON.stringify({ ok: true, data: { help: CLI_HELP } })}\n` : CLI_HELP,
      );
      return 0;
    }
    const secrets: string[] = [];
    let data: unknown;
    if (command.kind === "serve") {
      if (!dependencies.startServer) throw new CliError("NOT_AVAILABLE");
      try {
        data = await dependencies.startServer();
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError("START_FAILED");
      }
    } else {
      if (command.input === "api-key") {
        if (!dependencies.readSecret) throw new CliError("SECRET_REQUIRED");
        const key = (await dependencies.readSecret()).trim();
        if (Buffer.byteLength(key, "utf8") > 16384) throw new CliError("SECRET_TOO_LARGE");
        if (!key || hasControlCharacters(key)) throw new CliError("SECRET_REQUIRED");
        if (!isRecord(command.request.body)) throw new CliError("INVALID_ARGUMENTS");
        command.request.body.apiKey = key;
        secrets.push(key);
      }
      if (command.input === "channel-json") {
        if (!dependencies.readInput) throw new CliError("INPUT_REQUIRED");
        let raw: string;
        try {
          raw = await dependencies.readInput();
        } catch (error) {
          throw error instanceof CliError ? error : new CliError("INPUT_REQUIRED");
        }
        const channel = parseChannelInput(raw);
        if (typeof channel.token === "string") secrets.push(channel.token);
        command.request.body = channel;
      }
      if (command.input === "executor-json") {
        if (!dependencies.readInput) throw new CliError("INPUT_REQUIRED");
        const raw = await dependencies.readInput();
        let input: unknown;
        try {
          input = JSON.parse(raw);
        } catch {
          throw new CliError("INVALID_INPUT");
        }
        if (
          !isRecord(input) ||
          Object.keys(input).some(
            (key) => !["id", "credentialSource", "modelProfileId", "model"].includes(key),
          )
        )
          throw new CliError("INVALID_INPUT");
        command.request.body = input;
      }
      let connection: ManagementConnection;
      try {
        connection = await dependencies.resolveConnection();
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError("AUTH_REQUIRED");
      }
      secrets.push(connection.token);
      data = await createManagementClient(connection, {
        ...(command.request.path === "/manage/executors/claude-code/check"
          ? { timeoutMs: 120_000 }
          : {}),
        ...(command.request.path.endsWith("/trace") ? { maxResponseBytes: 6 * 1024 * 1024 } : {}),
        ...dependencies.clientOptions,
      }).request(command.request);
    }
    const output = publicOutput(data, secrets);
    dependencies.stdout(
      `${JSON.stringify(json ? { ok: true, data: output } : output, null, json ? undefined : 2)}\n`,
    );
    return 0;
  } catch (error) {
    const safe = error instanceof CliError ? error : new CliError("INTERNAL_ERROR");
    if (json)
      dependencies.stdout(
        `${JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message } })}\n`,
      );
    else dependencies.stderr(`${safe.code}: ${safe.message}\n`);
    return safe.code === "INVALID_ARGUMENTS" || safe.code === "INVALID_INPUT" ? 2 : 1;
  }
}
