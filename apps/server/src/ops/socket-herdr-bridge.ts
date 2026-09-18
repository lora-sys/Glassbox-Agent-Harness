import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { HerdrAgentLifecycleState } from "@glassbox/contracts";
import type { HerdrBridge, HerdrEvent, HerdrSessionSnapshot } from "./herdr-bridge.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function state(value: unknown): HerdrAgentLifecycleState {
  return ["idle", "working", "blocked", "done", "unknown"].includes(String(value))
    ? (value as HerdrAgentLifecycleState)
    : "unknown";
}

type WorkerLaunch = {
  kind: string;
  args: string[];
  env: Record<string, string>;
  runtimeEvidence?: Record<string, unknown>;
};

export interface SocketHerdrBridgeOptions {
  socketPath: string;
  sessionId: string;
  socketPassword?: string;
  requestTimeoutMs?: number;
  workerLaunch?: WorkerLaunch | (() => Promise<WorkerLaunch>);
}

/** Herdr 0.9 JSON socket client. Glassbox authorization stays above this privileged bridge. */
export class SocketHerdrBridge implements HerdrBridge {
  private connected = false;
  private readonly subscriptions = new Map<string, net.Socket>();
  private readonly listeners = new Map<string, (event: HerdrEvent) => void>();
  private readonly childSubscriptions = new Map<string, Set<string>>();
  private readonly timeoutMs: number;

  constructor(private readonly options: SocketHerdrBridgeOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  private endpoint(): string {
    if (process.platform !== "win32") return this.options.socketPath;
    if (
      this.options.socketPath.startsWith("\\\\.\\pipe\\") ||
      this.options.socketPath.startsWith("//./pipe/")
    ) {
      return this.options.socketPath;
    }
    return `\\\\.\\pipe\\${path.resolve(this.options.socketPath)}`;
  }

  private payload(method: string, params: JsonObject): JsonObject {
    return {
      id: `glassbox:${randomUUID()}`,
      method,
      params,
      ...(this.options.socketPassword ? { password: this.options.socketPassword } : {}),
    };
  }

  private request(
    method: string,
    params: JsonObject = {},
    timeoutMs = this.timeoutMs,
  ): Promise<JsonObject> {
    const payload = this.payload(method, params);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.endpoint());
      let buffer = "";
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error(`Herdr request timed out: ${method}`)),
        timeoutMs,
      );
      const finish = (error?: Error, value?: JsonObject) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value ?? {});
      };
      socket.setEncoding("utf8");
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error("Herdr connection closed before response")));
      socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
          finish(new Error("Herdr response frame limit"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = object(JSON.parse(buffer.slice(0, newline)));
          if (response?.id !== payload.id) {
            finish(new Error("Herdr response id mismatch"));
            return;
          }
          const error = object(response?.error);
          if (error)
            finish(
              new Error(
                `Herdr ${text(error.code) ?? "error"}: ${text(error.message) ?? "request failed"}`,
              ),
            );
          else if (!object(response?.result)) finish(new Error("Invalid Herdr response"));
          else finish(undefined, object(response?.result));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  async connect(): Promise<void> {
    await this.request("ping");
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    for (const socket of this.subscriptions.values()) socket.destroy();
    this.subscriptions.clear();
    this.listeners.clear();
    this.childSubscriptions.clear();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async subscribe(
    onEvent: (event: HerdrEvent) => void,
    paneIds?: string[],
  ): Promise<{ subscriptionId: string }> {
    const subscriptionId = randomUUID();
    const snapshot = paneIds ? undefined : await this.getSnapshot();
    const payload = this.payload("events.subscribe", {
      subscriptions: paneIds
        ? paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId }))
        : [
            ...snapshot!.workspaces.flatMap((workspace) =>
              workspace.panes.map((pane) => ({
                type: "pane.agent_status_changed",
                pane_id: pane.paneId,
              })),
            ),
            { type: "pane.updated" },
            { type: "workspace.updated" },
            { type: "workspace.closed" },
          ],
    });
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint());
      this.subscriptions.set(subscriptionId, socket);
      let buffer = "";
      let acknowledged = false;
      let terminated = false;
      const terminate = (error: Error) => {
        if (terminated) return;
        terminated = true;
        clearTimeout(timer);
        const intentional = !this.subscriptions.has(subscriptionId);
        if (!intentional) this.connected = false;
        this.subscriptions.delete(subscriptionId);
        socket.destroy();
        if (!acknowledged) reject(error);
        else if (!intentional)
          onEvent({
            type: "session.disconnected",
            sessionId: this.options.sessionId,
            workspaceId: "",
            paneId: "",
            timestamp: new Date().toISOString(),
          });
      };
      const timer = setTimeout(
        () => terminate(new Error("Herdr subscription acknowledgement timed out")),
        this.timeoutMs,
      );
      socket.setEncoding("utf8");
      socket.once("error", (error) => {
        terminate(error);
      });
      socket.once("close", () => {
        terminate(new Error("Herdr subscription closed"));
      });
      socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
          terminate(new Error("Herdr subscription frame limit"));
          return;
        }
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: JsonObject | undefined;
          try {
            message = object(JSON.parse(line));
          } catch {
            terminate(new Error("Invalid Herdr event frame"));
            return;
          }
          if (!acknowledged) {
            if (message?.id !== payload.id) {
              terminate(new Error("Herdr acknowledgement id mismatch"));
              return;
            }
            const error = object(message?.error);
            if (error) {
              terminate(new Error("Herdr subscription rejected"));
              return;
            }
            acknowledged = true;
            clearTimeout(timer);
            resolve();
            continue;
          }
          const event = this.mapEvent(message);
          if (event) onEvent(event);
        }
      });
    });
    this.connected = true;
    if (!paneIds) this.listeners.set(subscriptionId, onEvent);
    return { subscriptionId };
  }

  unsubscribe(subscriptionId: string): void {
    this.listeners.delete(subscriptionId);
    for (const child of this.childSubscriptions.get(subscriptionId) ?? []) this.unsubscribe(child);
    this.childSubscriptions.delete(subscriptionId);
    this.subscriptions.get(subscriptionId)?.destroy();
    this.subscriptions.delete(subscriptionId);
  }

  private mapEvent(message: JsonObject | undefined): HerdrEvent | null {
    const wrapper = object(message?.event) ?? object(message?.data) ?? message;
    let data = object(wrapper?.data) ?? wrapper ?? {};
    // Global events use underscore names; pane subscription events use dotted names.
    const kind = (text(message?.event) ?? text(data?.type) ?? text(wrapper?.type))?.replaceAll(
      ".",
      "_",
    );
    if (!kind) return null;
    if (kind === "pane_updated") data = object(data.pane) ?? {};
    if (kind === "pane_agent_status_changed" || kind === "pane_updated") {
      if (!text(data.workspace_id) || !text(data.pane_id)) return null;
      return {
        type: "agent.state",
        sessionId: this.options.sessionId,
        workspaceId: text(data.workspace_id) ?? "",
        paneId: text(data.pane_id) ?? "",
        // These events identify the runtime kind, not the named agent instance.
        // Reconciliation resolves identity and current state from a snapshot.
        state: state(data.agent_status),
        timestamp: new Date().toISOString(),
      };
    }
    if (kind === "pane_output_changed") {
      return {
        type: "agent.output",
        sessionId: this.options.sessionId,
        workspaceId: text(data.workspace_id) ?? "",
        paneId: text(data.pane_id) ?? "",
        timestamp: new Date().toISOString(),
      };
    }
    if (kind === "workspace_updated" || kind === "workspace_closed") {
      const workspace = object(data.workspace);
      return {
        type: "workspace.updated",
        sessionId: this.options.sessionId,
        workspaceId: text(data.workspace_id) ?? text(workspace?.workspace_id) ?? "",
        paneId: "",
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  }

  async getSnapshot(): Promise<HerdrSessionSnapshot> {
    const result = await this.request("session.snapshot");
    const snapshot = object(result.snapshot) ?? result;
    const workspaces = Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [];
    const panes = Array.isArray(snapshot.panes) ? snapshot.panes : [];
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
    return {
      sessionId: this.options.sessionId,
      timestamp: new Date().toISOString(),
      workspaces: workspaces.flatMap((entry) => {
        const workspace = object(entry);
        const workspaceId = text(workspace?.workspace_id);
        if (!workspaceId) return [];
        return [
          {
            workspaceId,
            panes: panes.flatMap((paneEntry) => {
              const pane = object(paneEntry) ?? {};
              if (text(pane?.workspace_id) !== workspaceId || !text(pane?.pane_id)) return [];
              const agent = agents.map(object).find((entry) => entry?.pane_id === pane.pane_id);
              return [
                {
                  paneId: text(pane.pane_id)!,
                  agentName: text(agent?.name),
                  agentKind: text(pane.agent) ?? "unknown",
                  state: state(pane.agent_status),
                  worktreePath: text(object(workspace?.worktree)?.checkout_path),
                  branch: text(object(workspace?.worktree)?.branch),
                },
              ];
            }),
          },
        ];
      }),
    };
  }

  async startAgent(params: {
    workspaceId: string;
    agentKind: string;
    worktreePath?: string;
    branch?: string;
    workerContextFile?: string;
  }): Promise<{ paneId: string; agentName: string; runtimeEvidence?: Record<string, unknown> }> {
    const launch =
      typeof this.options.workerLaunch === "function"
        ? await this.options.workerLaunch()
        : this.options.workerLaunch;
    if (params.agentKind === "pi" && !launch)
      throw new Error("Pi Worker requires a configured Kit launch policy");
    if (launch && launch.kind !== params.agentKind)
      throw new Error("Worker kind differs from configured launch policy");
    if (
      launch?.kind === "pi" &&
      (!params.workerContextFile || !path.isAbsolute(params.workerContextFile))
    )
      throw new Error("Pi Worker requires a Glassbox attempt context");
    const launchEnv = launch
      ? {
          ...launch.env,
          ...(params.workerContextFile
            ? { GLASSBOX_WORKER_CONTEXT: params.workerContextFile }
            : {}),
        }
      : undefined;
    let snapshot = await this.getSnapshot();
    let workspace = snapshot.workspaces.find(
      (candidate) => candidate.workspaceId === params.workspaceId,
    );
    if (!workspace) {
      const created = await this.request("workspace.create", {
        cwd: params.worktreePath ?? null,
        label: params.workspaceId,
        focus: false,
        ...(launchEnv ? { env: launchEnv } : {}),
      });
      const record = object(created.workspace);
      const workspaceId = text(record?.workspace_id);
      if (!workspaceId) throw new Error("Herdr workspace.create did not return a workspace id");
      snapshot = await this.getSnapshot();
      workspace = snapshot.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    }
    if (!workspace) throw new Error(`Herdr workspace not found: ${params.workspaceId}`);
    // Each attempt gets a full-width tab. Repeated splits eventually make Pi's
    // terminal too narrow to render and must not be used as worker isolation.
    const pane = await (async () => {
      const split = await this.request("tab.create", {
        workspace_id: workspace.workspaceId,
        label: `Glassbox ${params.agentKind}`,
        cwd: params.worktreePath ?? null,
        focus: true,
        ...(launchEnv ? { env: launchEnv } : {}),
      });
      const paneRecord = object(split.root_pane);
      const paneId = text(paneRecord?.pane_id);
      if (!paneId) throw new Error("Herdr tab.create did not return a root pane id");
      return { paneId };
    })();
    const agentName = `glassbox-${params.agentKind}-${randomUUID().slice(0, 8)}`;
    // Pane-specific subscriptions do not automatically cover panes created later.
    // Attach each observer before the new Agent can receive work.
    for (const [parent, listener] of this.listeners) {
      const child = await this.subscribe(listener, [pane.paneId]);
      if (!this.listeners.has(parent)) this.unsubscribe(child.subscriptionId);
      else {
        const children = this.childSubscriptions.get(parent) ?? new Set<string>();
        children.add(child.subscriptionId);
        this.childSubscriptions.set(parent, children);
      }
    }
    await this.request(
      "agent.start",
      {
        name: agentName,
        kind: params.agentKind,
        pane_id: pane.paneId,
        args: launch?.args ?? [],
        timeout_ms: 30_000,
      },
      35_000,
    );
    return { paneId: pane.paneId, agentName, runtimeEvidence: launch?.runtimeEvidence };
  }

  async promptAgent(params: { paneId: string; agentName?: string; prompt: string }): Promise<void> {
    // The socket launch response can precede interactive readiness on Windows.
    // Observe readiness without submitting any input until the named Agent owns the pane.
    const deadline = Date.now() + 30_000;
    while (true) {
      const result = await this.request("agent.get", { target: params.paneId });
      const agent = object(result.agent);
      if (agent?.pane_id !== params.paneId || !text(agent.name))
        throw new Error("Herdr agent identity unavailable");
      if (params.agentName && agent.name !== params.agentName)
        throw new Error("Herdr agent identity mismatch");
      if (agent.agent_status === "blocked")
        throw new Error("Herdr worker needs input before prompting");
      if (agent.interactive_ready === true && agent.launch_pending !== true) {
        await this.request("agent.prompt", { target: text(agent.name)!, text: params.prompt });
        return;
      }
      if (Date.now() >= deadline)
        throw new Error("Herdr worker readiness timed out; no prompt was submitted");
      await delay(100);
    }
  }

  async readAgent(params: {
    paneId: string;
    agentName?: string;
  }): Promise<{ output: string; state: HerdrAgentLifecycleState }> {
    if (params.agentName) await this.verifyAgent(params);
    const result = await this.request("agent.read", {
      target: params.agentName ?? params.paneId,
      source: "recent_unwrapped",
      lines: 200,
      format: "text",
      strip_ansi: true,
    });
    const read = object(result.read);
    if (read?.pane_id !== params.paneId || typeof read.text !== "string")
      throw new Error("Invalid Herdr agent.read result");
    const observed = await this.request("agent.get", { target: params.paneId });
    const agent = object(observed.agent);
    if (agent?.pane_id !== params.paneId) throw new Error("Herdr agent identity mismatch");
    if (params.agentName && agent.name !== params.agentName)
      throw new Error("Herdr agent identity mismatch");
    return { output: read.text, state: state(agent.agent_status) };
  }

  async waitAgent(params: {
    paneId: string;
    timeoutMs?: number;
  }): Promise<{ state: HerdrAgentLifecycleState }> {
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;
    const result = await this.request(
      "agent.wait",
      { target: params.paneId, until: ["blocked", "done"], timeout_ms: timeoutMs },
      timeoutMs + 1_000,
    );
    const agent = object(result.agent);
    if (agent?.pane_id === params.paneId) return { state: state(agent.agent_status) };
    const event = this.mapEvent(object(result.event));
    if (event?.paneId !== params.paneId || !event.state)
      throw new Error("Invalid Herdr agent.wait result");
    return { state: event.state };
  }

  private async verifyAgent(params: { paneId: string; agentName?: string }): Promise<void> {
    const result = await this.request("agent.get", { target: params.agentName ?? params.paneId });
    const agent = object(result.agent);
    if (agent?.pane_id !== params.paneId || (params.agentName && agent.name !== params.agentName))
      throw new Error("Herdr agent identity mismatch");
  }

  async stopAgent(params: { paneId: string; agentName?: string }): Promise<void> {
    if (params.agentName) await this.verifyAgent(params);
    await this.request("pane.send_keys", { pane_id: params.paneId, keys: ["ctrl+c"] });
  }
}
