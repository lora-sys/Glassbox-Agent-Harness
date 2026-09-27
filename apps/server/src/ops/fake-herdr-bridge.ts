import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { HerdrAgentLifecycleState } from "@glassbox/contracts";
import { workerTabLabel } from "./herdr-bridge.js";
import type {
  HerdrBridge,
  HerdrEvent,
  HerdrPaneInfo,
  HerdrSessionSnapshot,
  HerdrWorkspaceInfo,
} from "./herdr-bridge.js";

interface InternalPane extends HerdrPaneInfo {
  workspaceId: string;
  outputBuffer: string[];
  lastPrompt?: string;
}

export class FakeHerdrBridge implements HerdrBridge {
  private connected = true;
  private readonly sessionId: string;
  private readonly workspaces = new Map<string, Map<string, InternalPane>>();
  private readonly subscribers = new Map<string, (event: HerdrEvent) => void>();
  private readonly stateWaiters = new Map<
    string,
    Array<{ state: HerdrAgentLifecycleState; resolve: () => void }>
  >();

  constructor(sessionId = "fake-herdr-session") {
    this.sessionId = sessionId;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit({
      type: "session.disconnected",
      sessionId: this.sessionId,
      workspaceId: "",
      paneId: "",
      timestamp: new Date().toISOString(),
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async subscribe(onEvent: (event: HerdrEvent) => void): Promise<{ subscriptionId: string }> {
    const subscriptionId = randomUUID();
    this.subscribers.set(subscriptionId, onEvent);
    return { subscriptionId };
  }

  unsubscribe(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId);
  }

  async getSnapshot(): Promise<HerdrSessionSnapshot> {
    if (!this.connected) {
      throw new Error("HerdrBridge is disconnected");
    }
    const workspaces: HerdrWorkspaceInfo[] = [];
    for (const [workspaceId, panes] of this.workspaces.entries()) {
      const paneInfos: HerdrPaneInfo[] = [];
      for (const pane of panes.values()) {
        paneInfos.push({
          paneId: pane.paneId,
          tabId: pane.tabId,
          tabLabel: pane.tabLabel,
          agentName: pane.agentName,
          agentKind: pane.agentKind,
          state: pane.state,
          cwd: pane.cwd,
          worktreePath: pane.worktreePath,
          branch: pane.branch,
        });
      }
      workspaces.push({ workspaceId, panes: paneInfos });
    }
    return {
      sessionId: this.sessionId,
      workspaces,
      timestamp: new Date().toISOString(),
    };
  }

  async startAgent(params: {
    workspaceId: string;
    agentKind: string;
    agentName?: string;
    worktreePath?: string;
    branch?: string;
  }): Promise<{ paneId: string; agentName: string }> {
    if (!this.connected) {
      throw new Error("HerdrBridge is disconnected");
    }
    if (params.agentName && !/^glassbox-[a-z0-9-]{1,56}$/u.test(params.agentName))
      throw new Error("Invalid stable Herdr agent identity");
    if (params.agentName) {
      for (const [workspaceId, panes] of this.workspaces) {
        for (const pane of panes.values()) {
          if (pane.agentName !== params.agentName) continue;
          if (
            workspaceId !== params.workspaceId ||
            pane.agentKind !== params.agentKind ||
            pane.worktreePath !== params.worktreePath ||
            pane.branch !== params.branch
          )
            throw new Error("Stable Herdr agent identity is bound elsewhere");
          throw new Error("Stable Herdr agent identity already exists; reconcile before dispatch");
        }
      }
    }
    const paneId = `pane-${randomUUID().slice(0, 8)}`;
    const agentName = params.agentName ?? `agent-${params.agentKind}-${randomUUID().slice(0, 4)}`;

    let workspace = this.workspaces.get(params.workspaceId);
    if (!workspace) {
      workspace = new Map();
      this.workspaces.set(params.workspaceId, workspace);
    }

    const pane: InternalPane = {
      paneId,
      tabId: `tab-${randomUUID().slice(0, 8)}`,
      tabLabel: workerTabLabel(agentName),
      workspaceId: params.workspaceId,
      agentName,
      agentKind: params.agentKind,
      state: "working",
      cwd: params.worktreePath,
      worktreePath: params.worktreePath,
      branch: params.branch,
      outputBuffer: [],
    };
    workspace.set(paneId, pane);

    this.emit({
      type: "agent.state",
      sessionId: this.sessionId,
      workspaceId: params.workspaceId,
      paneId,
      agentName,
      state: "working",
      timestamp: new Date().toISOString(),
    });

    return { paneId, agentName };
  }

  async promptAgent(params: { paneId: string; agentName?: string; prompt: string }): Promise<void> {
    const pane = this.findPane(params.paneId);
    if (!pane) throw new Error(`Pane not found: ${params.paneId}`);
    if (params.agentName && params.agentName !== pane.agentName)
      throw new Error("Herdr agent identity mismatch");
    pane.lastPrompt = params.prompt;
    pane.state = "working";
    this.emit({
      type: "agent.state",
      sessionId: this.sessionId,
      workspaceId: pane.workspaceId,
      paneId: pane.paneId,
      agentName: pane.agentName,
      state: "working",
      timestamp: new Date().toISOString(),
    });
  }

  async readAgent(params: {
    paneId: string;
    agentName?: string;
  }): Promise<{ output: string; state: HerdrAgentLifecycleState }> {
    const pane = this.findPane(params.paneId);
    if (!pane) throw new Error(`Pane not found: ${params.paneId}`);
    if (params.agentName && params.agentName !== pane.agentName)
      throw new Error("Herdr agent identity mismatch");
    return {
      output: pane.outputBuffer.join(""),
      state: pane.state,
    };
  }

  async waitAgent(params: {
    paneId: string;
    timeoutMs?: number;
  }): Promise<{ state: HerdrAgentLifecycleState }> {
    const pane = this.findPane(params.paneId);
    if (!pane) throw new Error(`Pane not found: ${params.paneId}`);
    if (pane.state === "done" || pane.state === "blocked") {
      return { state: pane.state };
    }
    const timeoutMs = params.timeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for agent in pane ${params.paneId}`));
      }, timeoutMs);

      const checkWaiter = () => {
        if (pane.state === "done" || pane.state === "blocked") {
          clearTimeout(timer);
          resolve({ state: pane.state });
        }
      };

      const waiters = this.stateWaiters.get(params.paneId) ?? [];
      waiters.push({ state: "done", resolve: checkWaiter });
      waiters.push({ state: "blocked", resolve: checkWaiter });
      this.stateWaiters.set(params.paneId, waiters);
    });
  }

  async stopAgent(params: { paneId: string; agentName?: string }): Promise<void> {
    const pane = this.findPane(params.paneId);
    if (!pane) return;
    if (params.agentName && params.agentName !== pane.agentName)
      throw new Error("Herdr agent identity mismatch");
    pane.state = "idle";
    this.emit({
      type: "agent.state",
      sessionId: this.sessionId,
      workspaceId: pane.workspaceId,
      paneId: pane.paneId,
      agentName: pane.agentName,
      state: "idle",
      timestamp: new Date().toISOString(),
    });
  }

  async closeAgent(params: {
    paneId: string;
    agentName: string;
    herdrSession: string;
  }): Promise<void> {
    if (!this.connected) throw new Error("HerdrBridge is disconnected");
    if (!params.herdrSession || params.herdrSession !== this.sessionId)
      throw new Error("Herdr session identity mismatch");
    const before = await this.getSnapshot();
    if (before.sessionId !== params.herdrSession)
      throw new Error("Herdr session identity mismatch");
    const paneInfo = before.workspaces
      .flatMap((workspace) => workspace.panes)
      .find((entry) => entry.paneId === params.paneId);
    if (!paneInfo) return;
    if (paneInfo.agentName !== params.agentName) throw new Error("Herdr agent identity mismatch");
    const pane = this.findPane(params.paneId);
    if (!pane || pane.agentName !== params.agentName)
      throw new Error("Herdr agent identity mismatch");
    this.workspaces.get(pane.workspaceId)?.delete(pane.paneId);
    this.emit({
      type: "workspace.updated",
      sessionId: this.sessionId,
      workspaceId: pane.workspaceId,
      paneId: "",
      timestamp: new Date().toISOString(),
    });
    const snapshot = await this.getSnapshot();
    if (!this.connected || snapshot.sessionId !== params.herdrSession)
      throw new Error("Herdr session identity mismatch");
    if (
      snapshot.workspaces.some((workspace) =>
        workspace.panes.some((entry) => entry.paneId === pane.paneId),
      )
    )
      throw new Error("Herdr pane close was not confirmed");
  }

  async closePreAgentPane(params: {
    herdrSession: string;
    workspaceId: string;
    paneId: string;
    agentName: string;
    tabLabel: string;
    cwd: string;
  }): Promise<void> {
    if (!this.connected) throw new Error("HerdrBridge is disconnected");
    if (!params.herdrSession || params.herdrSession !== this.sessionId)
      throw new Error("Herdr session identity mismatch");
    const before = await this.getSnapshot();
    if (before.sessionId !== params.herdrSession)
      throw new Error("Herdr session identity mismatch");
    const matches = before.workspaces.flatMap((workspace) =>
      workspace.panes
        .filter((pane) => pane.paneId === params.paneId)
        .map((pane) => ({ workspace, pane })),
    );
    if (matches.length === 0) throw new Error("Herdr pre-agent pane is absent before close");
    if (matches.length !== 1) throw new Error("Herdr pre-agent pane identity mismatch");
    const { workspace, pane } = matches[0]!;
    if (
      workspace.workspaceId !== params.workspaceId ||
      pane.tabLabel !== params.tabLabel ||
      (pane.agentName !== undefined && pane.agentName !== params.agentName)
    )
      throw new Error("Herdr pre-agent pane identity mismatch");
    if (!pane.cwd) throw new Error("Herdr pre-agent pane cwd is unavailable");
    let actualCwd: string;
    let expectedCwd: string;
    try {
      [actualCwd, expectedCwd] = await Promise.all([realpath(pane.cwd), realpath(params.cwd)]);
    } catch {
      throw new Error("Herdr pre-agent pane cwd could not be verified");
    }
    if (actualCwd !== expectedCwd) throw new Error("Herdr pre-agent pane cwd mismatch");
    const internal = this.findPane(params.paneId);
    if (!internal || internal.workspaceId !== params.workspaceId)
      throw new Error("Herdr pre-agent pane identity mismatch");
    this.workspaces.get(params.workspaceId)?.delete(params.paneId);
    const after = await this.getSnapshot();
    if (
      !this.connected ||
      after.sessionId !== params.herdrSession ||
      after.workspaces.some((workspace) =>
        workspace.panes.some(
          (entry) =>
            entry.paneId === params.paneId ||
            entry.tabLabel === params.tabLabel ||
            entry.agentName === params.agentName,
        ),
      )
    )
      throw new Error("Herdr pane close was not confirmed");
  }

  simulatePreAgentTab(params: {
    workspaceId: string;
    agentName: string;
    worktreePath: string;
  }): string {
    const paneId = `pane-${randomUUID().slice(0, 8)}`;
    let workspace = this.workspaces.get(params.workspaceId);
    if (!workspace) {
      workspace = new Map();
      this.workspaces.set(params.workspaceId, workspace);
    }
    workspace.set(paneId, {
      paneId,
      tabId: `tab-${randomUUID().slice(0, 8)}`,
      tabLabel: workerTabLabel(params.agentName),
      workspaceId: params.workspaceId,
      agentKind: "unknown",
      state: "idle",
      cwd: params.worktreePath,
      worktreePath: params.worktreePath,
      outputBuffer: [],
    });
    return paneId;
  }

  // --- Test helper methods ---

  simulateAgentState(paneId: string, state: HerdrAgentLifecycleState, output?: string): void {
    const pane = this.findPane(paneId);
    if (!pane) throw new Error(`Pane not found: ${paneId}`);
    pane.state = state;
    if (output) {
      pane.outputBuffer.push(output);
    }
    this.emit({
      type: "agent.state",
      sessionId: this.sessionId,
      workspaceId: pane.workspaceId,
      paneId,
      agentName: pane.agentName,
      state,
      text: output,
      timestamp: new Date().toISOString(),
    });

    const waiters = this.stateWaiters.get(paneId);
    if (waiters) {
      for (const waiter of waiters) {
        if (waiter.state === state) waiter.resolve();
      }
    }
  }

  simulateAgentOutput(paneId: string, text: string): void {
    const pane = this.findPane(paneId);
    if (!pane) throw new Error(`Pane not found: ${paneId}`);
    pane.outputBuffer.push(text);
    this.emit({
      type: "agent.output",
      sessionId: this.sessionId,
      workspaceId: pane.workspaceId,
      paneId,
      agentName: pane.agentName,
      text,
      timestamp: new Date().toISOString(),
    });
  }

  simulateEvent(event: HerdrEvent): void {
    this.emit(event);
  }

  private findPane(paneId: string): InternalPane | undefined {
    for (const workspace of this.workspaces.values()) {
      const pane = workspace.get(paneId);
      if (pane) return pane;
    }
    return undefined;
  }

  private emit(event: HerdrEvent): void {
    for (const callback of this.subscribers.values()) {
      try {
        callback(event);
      } catch (err) {
        console.error("Error in FakeHerdrBridge event listener", err);
      }
    }
  }
}
