/** Public management contract. Credentials remain server-owned. */
export type ChannelConnectionState = "disconnected" | "connecting" | "connected" | "error";

export const CHANNEL_SAFE_ERRORS = {
  auth: "QQ 连接鉴权失败，请检查 token。",
  identity: "登录的机器人 QQ 号与配置不一致。",
  connection: "QQ 连接中断或无法建立，请检查本机 OneBot 服务。",
  configuration: "渠道配置不完整，请检查地址、QQ 号和 token。",
  execution: "所选执行方式无法用于此渠道，请检查执行配置。",
  unknown: "QQ 连接未能完成，请检查本机服务后重试。",
} as const;

export type ChannelSafeError = (typeof CHANNEL_SAFE_ERRORS)[keyof typeof CHANNEL_SAFE_ERRORS];

export interface ChannelSaveInput {
  visitorIds?: string[];
  id: string;
  label: string;
  kind: "qq-onebot";
  endpoint: string;
  botId: string;
  ownerId: string;
  coOwnerId?: string;
  groupIds: string[];
  executionRef: string;
  /** Omitted preserves the token, null clears it, a string replaces it. */
  token?: string | null;
}

export interface PublicChannelProfile extends Omit<ChannelSaveInput, "token"> {
  /** Owner selected model profile used by later Runs on this Channel. */
  modelOverrideProfileId?: string;
  tokenConfigured: boolean;
  /** A persisted instruction to reconnect when the server starts. */
  autoConnect: boolean;
  /** Current runtime observation, never persisted as connection evidence. */
  connectionState: ChannelConnectionState;
  lastError?: ChannelSafeError;
}
