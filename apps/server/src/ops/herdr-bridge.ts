import type { HerdrAgentLifecycleState } from "@glassbox/contracts";

export interface HerdrEvent {
  type: "agent.state" | "agent.output" | "workspace.updated" | "session.disconnected";
  sessionId: string;
  workspaceId: string;
  paneId: string;
  agentName?: string;
  state?: HerdrAgentLifecycleState;
  text?: string;
  timestamp: string;
}

export interface HerdrPaneInfo {
  paneId: string;
  agentName?: string;
  agentKind: string;
  state: HerdrAgentLifecycleState;
  worktreePath?: string;
  branch?: string;
}

export interface HerdrWorkspaceInfo {
  workspaceId: string;
  panes: HerdrPaneInfo[];
}

export interface HerdrSessionSnapshot {
  sessionId: string;
  workspaces: HerdrWorkspaceInfo[];
  timestamp: string;
}

export interface HerdrBridge {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  subscribe(onEvent: (event: HerdrEvent) => void): Promise<{ subscriptionId: string }>;
  getSnapshot(): Promise<HerdrSessionSnapshot>;
  startAgent(params: {
    workspaceId: string;
    agentKind: string;
    worktreePath?: string;
    branch?: string;
  }): Promise<{ paneId: string; agentName: string }>;
  promptAgent(params: { paneId: string; prompt: string }): Promise<void>;
  readAgent(params: { paneId: string }): Promise<{ output: string; state: HerdrAgentLifecycleState }>;
  waitAgent(params: { paneId: string; timeoutMs?: number }): Promise<{ state: HerdrAgentLifecycleState }>;
  stopAgent(params: { paneId: string }): Promise<void>;
}
