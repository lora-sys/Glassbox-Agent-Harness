import type { CallerContext } from "../identity/scope.js";

export type LearningProgressState = "observed" | "confirmed" | "deleted";
export type LearningProgressKind = "goal" | "milestone" | "question_cue";

export interface LearningProgressContext {
  caller: CallerContext;
  conversationId?: string;
  runId?: string;
}

export interface LearningProgressRecord {
  id: string;
  principalId: string;
  kind: LearningProgressKind;
  state: LearningProgressState;
  statement: string;
  confidence: number;
  revision: number;
  source: {
    runId: string;
    messageId: string;
    chatType: "private" | "group";
    connectionId: string;
    botId: string;
    chatId: string;
    senderId: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface LearningProgressList {
  records: LearningProgressRecord[];
  truncated: boolean;
}

export interface LearningProgressCommand {
  action: "list" | "capture" | "correct" | "delete" | "confirm";
  recordId?: string;
  statement?: string;
}
