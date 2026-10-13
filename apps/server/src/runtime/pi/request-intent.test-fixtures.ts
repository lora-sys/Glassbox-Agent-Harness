import type { RequiredEvidence, RequiredEvidenceInput } from "./required-evidence.js";

export interface RequestIntentContractCase {
  id: string;
  input: RequiredEvidenceInput;
  clauses: string;
  requiredEvidence: readonly RequiredEvidence[];
  requiredToolCall?: { name: string; input: Record<string, unknown> };
  toolResult?: unknown;
}

export const REQUEST_INTENT_CORPUS: readonly RequestIntentContractCase[] = [
  {
    id: "refuse-file-read-but-request-group-members",
    input: {
      text: "不要查看群文件，查看群 1126022432 有哪些成员。",
      chatType: "private",
      isOwner: true,
      botId: "3394947361",
    },
    clauses: "查看群 1126022432 有哪些成员",
    requiredEvidence: [
      {
        domain: "group_members",
        tool: "qq_group_members",
        input: { groupId: "1126022432", operation: "get_group_member_list" },
      },
    ],
  },
  {
    id: "refuse-account-details-but-request-login-status",
    input: {
      text: "检查机器人当前是否在线，只告诉我在线状态，不用提供 QQ 号码或其他账号资料。",
      chatType: "private",
      isOwner: true,
      botId: "3394947361",
    },
    clauses: "检查机器人当前是否在线，只告诉我在线状态，不用提供 QQ 号码或其他账号资料",
    requiredEvidence: [
      {
        domain: "account_status",
        tool: "qq_account_status",
        input: { operation: "get_status" },
      },
    ],
  },
  {
    id: "read-member-profile-with-modification-refusal",
    input: {
      text: "帮我查一下 OATP 群 1121579672 里 QQ 2498701175 的群昵称和群名片是什么？只告诉我查到的信息，不要修改任何群资料。",
      chatType: "private",
      isOwner: true,
      botId: "3394947361",
    },
    clauses:
      "帮我查一下 OATP 群 1121579672 里 QQ 2498701175 的群昵称和群名片是什么，只告诉我查到的信息",
    requiredEvidence: [
      {
        domain: "group_member_profile",
        tool: "qq_group_members",
        input: {
          groupId: "1121579672",
          operation: "get_group_member_info",
          params: { user_id: "2498701175" },
        },
      },
    ],
    requiredToolCall: {
      name: "qq_group_members",
      input: {
        groupId: "1121579672",
        operation: "get_group_member_info",
        params: { user_id: "2498701175" },
      },
    },
    toolResult: {
      details: {
        memberExists: true,
        qqId: "2498701175",
        nickname: "Ripped",
        card: "Ripped Space",
      },
    },
  },
  {
    id: "refuse-file-and-member-reads",
    input: {
      text: "不要查看群文件，也不要查群成员。",
      chatType: "private",
      isOwner: true,
      botId: "3394947361",
    },
    clauses: "",
    requiredEvidence: [],
  },
];
