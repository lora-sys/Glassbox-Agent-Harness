// Configuration-home and continuation-identity adaptation from t3code. See SOURCES.md.
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { scopeKey } from "../../identity/scope.js";
import type { ExecutionInput } from "../run-service/types.js";
import { HarnessFailure } from "./types.js";

export interface HarnessLayout {
  root: string;
  workspace: string;
  home: string;
  config: string;
  temp: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function conversationNamespace(input: ExecutionInput): string {
  if (
    input.conversation.id !== input.run.conversationId ||
    input.caller.principalId !== input.conversation.principalId ||
    scopeKey(input.caller.scope) !== scopeKey(input.conversation.scope)
  )
    throw new HarnessFailure("INVALID_INPUT");
  return digest(
    JSON.stringify([
      input.conversation.agentId,
      input.conversation.id,
      input.caller.principalId,
      scopeKey(input.caller.scope),
      input.run.executionRef,
    ]),
  );
}

async function childDirectory(parent: string, segment: string): Promise<string> {
  const target = path.join(parent, segment);
  await mkdir(target, { mode: 0o700 }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
      throw error;
  });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)) !== target) {
    throw new HarnessFailure("ISOLATION_VIOLATION");
  }
  return target;
}

export async function createHarnessLayout(
  dataDirectory: string,
  input: ExecutionInput,
): Promise<HarnessLayout> {
  if (!path.isAbsolute(dataDirectory)) throw new HarnessFailure("INVALID_INPUT");
  const namespace = conversationNamespace(input);
  // The configured data root is host-owned. Never traverse links beneath that root.
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  let root = await realpath(dataDirectory);
  for (const segment of ["harness", namespace, "runs", digest(input.run.id)]) {
    root = await childDirectory(root, segment);
  }
  const workspace = await childDirectory(root, "workspace");
  const home = await childDirectory(root, "home");
  const config = await childDirectory(root, "claude-config");
  const temp = await childDirectory(root, "temp");
  return { root, workspace, home, config, temp };
}
