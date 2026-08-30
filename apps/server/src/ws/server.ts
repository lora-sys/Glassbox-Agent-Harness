// apps/server/src/ws/server.ts
// WebSocket layer for live event streaming and client control.

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

import { screenValue } from "../screening/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** JSON messages from the client. */
export interface SubscribeMessage {
  action: "subscribe";
  sessionId: string;
}

export interface InterruptMessage {
  action: "interrupt";
  sessionId: string;
}

export type ClientMessage = SubscribeMessage | InterruptMessage;

/** Messages pushed to the client. */
export interface LiveEventPayload {
  type: "event";
  event: Record<string, unknown>;
}

export interface DerivedStatePayload {
  type: "derivedState";
  derivedState: Record<string, unknown>;
}

export interface ErrorPayload {
  type: "error";
  message: string;
}

export interface SessionEndedPayload {
  type: "sessionEnded";
  sessionId: string;
}

export interface ApprovalPushPayload {
  type: "approval";
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason: string | null;
  grantRoot: string | null;
}

export type ServerPush = LiveEventPayload | DerivedStatePayload | ErrorPayload | SessionEndedPayload | ApprovalPushPayload;

// ---------------------------------------------------------------------------
// Internal subscriber tracking
// ---------------------------------------------------------------------------

interface Subscriber {
  ws: WebSocket;
  sessionId: string;
}

const subscribers = new Map<string, Set<Subscriber>>();

// ---------------------------------------------------------------------------
// Public API: broadcast to all subscribers of a session
// ---------------------------------------------------------------------------

/**
 * Push a decoded event to every WebSocket subscriber for this session.
 * Strings in the event payload are screened for secrets before shipping.
 */
export function broadcastEvent(sessionId: string, event: Record<string, unknown>): void {
  const room = subscribers.get(sessionId);
  if (!room || room.size === 0) return;

  // Screen event params for secrets without mutating the caller's object
  const safeEvent = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  const payload: LiveEventPayload = { type: "event", event: screenValue(safeEvent) as Record<string, unknown> };
  const data = JSON.stringify(payload);

  for (const sub of room) {
    if (sub.ws.readyState === WebSocket.OPEN) {
      sub.ws.send(data);
    }
  }
}

/**
 * Push a derived-state snapshot to every subscriber.
 * Strings in the state are screened for secrets before shipping.
 */
export function broadcastDerivedState(sessionId: string, state: Record<string, unknown>): void {
  const room = subscribers.get(sessionId);
  if (!room || room.size === 0) return;

  // Screen derived state for secrets without mutating the caller's object
  const safeState = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  const payload: DerivedStatePayload = { type: "derivedState", derivedState: screenValue(safeState) as Record<string, unknown> };
  const data = JSON.stringify(payload);

  for (const sub of room) {
    if (sub.ws.readyState === WebSocket.OPEN) {
      sub.ws.send(data);
    }
  }
}

/**
 * Push a file-change approval request to every subscriber.
 */
export function broadcastApproval(sessionId: string, approval: Record<string, unknown>): void {
  const room = subscribers.get(sessionId);
  if (!room || room.size === 0) return;

  const payload: ApprovalPushPayload = { type: "approval", ...approval } as ApprovalPushPayload;
  const data = JSON.stringify(payload);

  for (const sub of room) {
    if (sub.ws.readyState === WebSocket.OPEN) {
      sub.ws.send(data);
    }
  }
}

/**
 * Push a sessionEnded notification and clean up subscribers.
 */
export function broadcastSessionEnded(sessionId: string): void {
  const room = subscribers.get(sessionId);
  if (!room || room.size === 0) return;

  const payload: SessionEndedPayload = { type: "sessionEnded", sessionId };
  const data = JSON.stringify(payload);

  for (const sub of room) {
    if (sub.ws.readyState === WebSocket.OPEN) {
      sub.ws.send(data);
    }
  }
  subscribers.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Mount function
// ---------------------------------------------------------------------------

/**
 * Attach the WebSocket server to an existing HTTP server.
 * @param httpServer - the Node.js HTTP server instance
 * @param onInterrupt - callback when a client sends an interrupt action
 */
export function attachWebSocketServer(
  httpServer: Server,
  onInterrupt: (sessionId: string) => Promise<void> | void,
  onSubscribe?: (sessionId: string) => ApprovalPushPayload[]
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    // Read sessionId from handshake query string (?sessionId=...) so the
    // server can track the subscription even before the first {action:"subscribe"}
    // message arrives. This keeps the WS protocol stateless on connect.
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId") ?? "";

      void handleSubscribe(ws, sessionId, onSubscribe);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        handleMessage(ws, msg, onInterrupt, onSubscribe);
      } catch {
        sendError(ws, "invalid json message");
      }
    });

    ws.on("close", () => {
      // Remove this subscriber from all session rooms
      for (const [sid, room] of subscribers) {
        room.forEach((sub) => {
          if (sub.ws === ws || sub.ws === ws) {
            room.delete(sub);
          }
        });
        if (room.size === 0) {
          subscribers.delete(sid);
        }
      }
    });
  });

  return wss;
}

// ---------------------------------------------------------------------------
// Internal message handlers
// ---------------------------------------------------------------------------

async function handleSubscribe(
  ws: WebSocket,
  sessionId: string,
  onSubscribe?: (sessionId: string) => ApprovalPushPayload[]
): Promise<void> {
  if (!sessionId) {
    sendError(ws, "missing sessionId in query or subscribe message");
    return;
  }

  if (!subscribers.has(sessionId)) {
    subscribers.set(sessionId, new Set());
  }
  subscribers.get(sessionId)!.add({ ws, sessionId });

  // Acknowledge subscription
  ws.send(JSON.stringify({ type: "subscribed", sessionId }));

  // Catch-up: push approval requests that fired before this client
  // subscribed. Without this, a decision that arrives between the run POST
  // and the WS open is invisible to the UI and can never be answered.
  if (onSubscribe) {
    for (const approval of onSubscribe(sessionId)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(approval));
      }
    }
  }
}

async function handleMessage(
  ws: WebSocket,
  msg: ClientMessage,
  onInterrupt: (sessionId: string) => Promise<void> | void,
  onSubscribe?: (sessionId: string) => ApprovalPushPayload[]
): Promise<void> {
  if (msg.action === "interrupt") {
    try {
      await onInterrupt(msg.sessionId);
      ws.send(JSON.stringify({ type: "interrupted", sessionId: msg.sessionId }));
    } catch {
      sendError(ws, `interrupt failed for session ${msg.sessionId}`);
    }
  } else if (msg.action === "subscribe") {
    await handleSubscribe(ws, msg.sessionId, onSubscribe);
  } else {
    sendError(ws, `unknown action: ${(msg as { action: string }).action}`);
  }
}

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "error", message } satisfies ErrorPayload));
  }
}
