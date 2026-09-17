import { PRIVATE_CANARY } from "@glassbox/contracts";
import type { HerdrSessionSnapshot } from "../ops/herdr-bridge.js";

export const CANARY_SECRET_VALUE = PRIVATE_CANARY;
export const CANARY_RESOURCE_ID = "owner-canary-secret";

export const FIXTURE_BOT_ID = "10001";
export const FIXTURE_OWNER_ID = "10002";
export const FIXTURE_VISITOR_ID = "20002";
export const FIXTURE_GROUP_ID = "10003";
export const FIXTURE_CONNECTION_ID = "napcat-test";

/** OneBot 11 raw message packet captures */
export const OWNER_PRIVATE_MESSAGE = {
  time: 1726560000,
  post_type: "message",
  message_type: "private",
  sub_type: "friend",
  self_id: Number(FIXTURE_BOT_ID),
  user_id: Number(FIXTURE_OWNER_ID),
  message_id: 101,
  message: "Run a disposable coding task",
  raw_message: "Run a disposable coding task",
  font: 0,
  sender: {
    user_id: Number(FIXTURE_OWNER_ID),
    nickname: "Owner",
  },
};

export const VISITOR_PRIVATE_MESSAGE = {
  time: 1726560001,
  post_type: "message",
  message_type: "private",
  sub_type: "friend",
  self_id: Number(FIXTURE_BOT_ID),
  user_id: Number(FIXTURE_VISITOR_ID),
  message_id: 102,
  message: "Can I inspect the owner canary?",
  raw_message: "Can I inspect the owner canary?",
  font: 0,
  sender: {
    user_id: Number(FIXTURE_VISITOR_ID),
    nickname: "Visitor",
  },
};

export const GROUP_MESSAGE_WITH_AT = {
  time: 1726560002,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  self_id: Number(FIXTURE_BOT_ID),
  user_id: Number(FIXTURE_OWNER_ID),
  group_id: Number(FIXTURE_GROUP_ID),
  message_id: 103,
  message: [
    { type: "at", data: { qq: FIXTURE_BOT_ID } },
    { type: "text", data: { text: " 检查任务状态" } },
  ],
  raw_message: `[CQ:at,qq=${FIXTURE_BOT_ID}] 检查任务状态`,
  anonymous: null,
  sender: {
    user_id: Number(FIXTURE_OWNER_ID),
    nickname: "Owner",
    role: "owner",
  },
};

export const GROUP_MESSAGE_WITHOUT_AT = {
  time: 1726560003,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  self_id: Number(FIXTURE_BOT_ID),
  user_id: Number(FIXTURE_OWNER_ID),
  group_id: Number(FIXTURE_GROUP_ID),
  message_id: 104,
  message: [{ type: "text", data: { text: "这是一条普通群聊消息，未提及bot" } }],
  raw_message: "这是一条普通群聊消息，未提及bot",
  anonymous: null,
  sender: {
    user_id: Number(FIXTURE_OWNER_ID),
    nickname: "Owner",
    role: "owner",
  },
};

export const DUPLICATE_MESSAGE_PACKET = {
  ...OWNER_PRIVATE_MESSAGE,
  message_id: 9999,
};

export const SELF_MESSAGE_PACKET = {
  time: 1726560004,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  self_id: Number(FIXTURE_BOT_ID),
  user_id: Number(FIXTURE_BOT_ID),
  group_id: Number(FIXTURE_GROUP_ID),
  message_id: 105,
  message: [{ type: "text", data: { text: "Self loop message from bot" } }],
  raw_message: "Self loop message from bot",
  anonymous: null,
};

/** Herdr session snapshot fixtures */
export const INITIAL_HERDR_SNAPSHOT: HerdrSessionSnapshot = {
  sessionId: "herdr-test-session",
  workspaces: [
    {
      workspaceId: "ws-test-1",
      panes: [],
    },
  ],
  timestamp: "2026-09-17T07:00:00.000Z",
};

export const ACTIVE_HERDR_SNAPSHOT: HerdrSessionSnapshot = {
  sessionId: "herdr-test-session",
  workspaces: [
    {
      workspaceId: "ws-test-1",
      panes: [
        {
          paneId: "pane-active-1",
          agentName: "agent-worker-1",
          agentKind: "codex",
          state: "working",
          worktreePath: "/tmp/worktree-1",
          branch: "feature/task-1",
        },
      ],
    },
  ],
  timestamp: "2026-09-17T07:01:00.000Z",
};

export const BLOCKED_HERDR_SNAPSHOT: HerdrSessionSnapshot = {
  sessionId: "herdr-test-session",
  workspaces: [
    {
      workspaceId: "ws-test-1",
      panes: [
        {
          paneId: "pane-active-1",
          agentName: "agent-worker-1",
          agentKind: "codex",
          state: "blocked",
          worktreePath: "/tmp/worktree-1",
          branch: "feature/task-1",
        },
      ],
    },
  ],
  timestamp: "2026-09-17T07:02:00.000Z",
};

export const DONE_HERDR_SNAPSHOT: HerdrSessionSnapshot = {
  sessionId: "herdr-test-session",
  workspaces: [
    {
      workspaceId: "ws-test-1",
      panes: [
        {
          paneId: "pane-active-1",
          agentName: "agent-worker-1",
          agentKind: "codex",
          state: "done",
          worktreePath: "/tmp/worktree-1",
          branch: "feature/task-1",
        },
      ],
    },
  ],
  timestamp: "2026-09-17T07:03:00.000Z",
};
