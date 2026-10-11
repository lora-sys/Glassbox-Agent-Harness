import type { DatabaseSync } from "node:sqlite";

/** The independently read projection exercised by the server contract test. */
export function caseEvidence(
  database: DatabaseSync,
  caseRecord: {
    id: string;
    route: string;
    startedAt: string;
    sentMessageId: string;
    inputBinding: {
      driverMessageId: string;
      botMessageId: string;
      realSequence: string;
      time: number;
      textSha256: string;
      timeUnixMs?: number;
    };
  },
  config: {
    bot: { qq: string };
    driver: { qq: string };
    runtime: { connectionId: string; threadId: string | null };
  },
): {
  caseId: string;
  runId: string;
  runCreatedAt: string;
  scope: {
    connectionId: string;
    botId: string;
    chatType: "private" | "group";
    chatId: string;
    senderId: string;
    threadId?: string;
  };
  decisions: Array<{
    id: string;
    action: string;
    decision: "ALLOW" | "DENY" | "REQUIRES_APPROVAL";
  }>;
  filteredDecisions: Array<{
    decisionId: string;
    eventId: string;
    projection: "conversation-history" | "task-list" | "ops-health-records";
  }>;
  deliveries: Array<{
    id: string;
    status: string;
    external_id: string | null;
    destination_scope_key: string;
  }>;
  delivery: {
    id: string;
    status: "sent";
    external_id: string | null;
    destination_scope_key: string;
  };
};
