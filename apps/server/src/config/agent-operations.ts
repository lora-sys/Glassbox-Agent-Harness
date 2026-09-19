import { readFile, stat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { SocketHerdrBridge } from "../ops/socket-herdr-bridge.js";

/** Trusted local configuration only. No channel or model may choose these targets. */
export async function loadAgentOperations(
  dataDirectory: string,
  databasePath = join(dataDirectory, "glassbox.db"),
) {
  const file = join(dataDirectory, "agent-operations.json");
  let value: Record<string, unknown>;
  try {
    if ((await stat(file)).size > 16384) throw new Error("limit");
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid agent operations configuration");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        !["socketPath", "sessionId", "workspaceId", "agentKind", "worktreePath", "pi"].includes(
          key,
        ),
    ) ||
    !["sessionId", "workspaceId", "agentKind"].every(
      (key) =>
        typeof value[key] === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u.test(value[key] as string),
    ) ||
    !["socketPath", "worktreePath"].every(
      (key) => typeof value[key] === "string" && isAbsolute(value[key] as string),
    )
  ) {
    throw new Error("Invalid agent operations configuration");
  }
  if (!(await stat(value.worktreePath as string)).isDirectory())
    throw new Error("Worker worktree directory is unavailable");
  let workerLaunch;
  if (value.agentKind === "pi" && value.pi === undefined)
    throw new Error("Pi Worker requires a configured Kit launch policy");
  if (value.pi !== undefined) {
    if (!isAbsolute(databasePath))
      throw new Error("Pi Worker requires a persistent absolute database path");
    const pi = value.pi as Record<string, unknown>;
    if (
      value.agentKind !== "pi" ||
      !pi ||
      typeof pi !== "object" ||
      Array.isArray(pi) ||
      Object.keys(pi).some((key) => !["kitPath", "agentDir", "provider", "model"].includes(key)) ||
      !["kitPath", "agentDir", "provider", "model"].every((key) => typeof pi[key] === "string")
    )
      throw new Error("Invalid Pi worker configuration");
    const { piWorkerLaunch } = await import("../runtime/pi/worker-launch.js");
    const root = await realpath(value.worktreePath as string);
    for (const protectedPath of [dataDirectory, pi.agentDir as string, pi.kitPath as string]) {
      const local = relative(root, await realpath(protectedPath));
      if (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))
        throw new Error("Worker directory contains trusted runtime state");
    }
    const configured = pi as { kitPath: string; agentDir: string; provider: string; model: string };
    await piWorkerLaunch(configured);
    // Revalidate locks and capture current resource fingerprints for each attempt.
    workerLaunch = () => piWorkerLaunch(configured);
  }
  return {
    workerPolicy: workerLaunch
      ? {
          databasePath,
          contextDirectory: join(dataDirectory, "worker-contexts"),
          resourceId: `worker-workspace:${value.workspaceId as string}`,
        }
      : undefined,
    bridge: new SocketHerdrBridge({
      socketPath: value.socketPath as string,
      sessionId: value.sessionId as string,
      workerLaunch,
    }),
    workerTarget: {
      workspaceId: value.workspaceId as string,
      agentKind: value.agentKind as string,
      worktreePath: value.worktreePath as string,
    },
  };
}
