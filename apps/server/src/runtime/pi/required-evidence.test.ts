import { describe, expect, it } from "vite-plus/test";
import { GROUP_HISTORY_SEARCH_TOOL, OWNER_HISTORY_SEARCH_TOOL } from "./history-tools.js";
import {
  asksLiveQqFact,
  requiredEvidenceFor,
  resolveEvidence,
  unobservedEvidence,
  type ObservedToolCall,
  type RequiredEvidenceInput,
} from "./required-evidence.js";

/** Every read-only QQ Tool the group surface carries, so a surface never hides a domain. */
const GROUP_SURFACE = [
  GROUP_HISTORY_SEARCH_TOOL,
  "qq_groups",
  "qq_group_members",
  "qq_group_history",
  "qq_group_content",
  "qq_group_files",
] as const;

/** The Owner-private surface, which additionally carries the cross-group search Tool. */
const OWNER_SURFACE = [...GROUP_SURFACE, OWNER_HISTORY_SEARCH_TOOL, "qq_account_status"] as const;

function inGroup(text: string, surface: readonly string[] = GROUP_SURFACE): RequiredEvidenceInput {
  return { text, chatType: "group", isOwner: false, authorizedToolNames: surface };
}

function ownerPrivate(
  text: string,
  surface: readonly string[] = OWNER_SURFACE,
): RequiredEvidenceInput {
  return { text, chatType: "private", isOwner: true, authorizedToolNames: surface };
}

/** The domain names required for a message, in the order the policy reports them. */
const domains = (input: RequiredEvidenceInput) =>
  requiredEvidenceFor(input).map((evidence) => evidence.domain);

describe("required evidence for a live QQ fact", () => {
  it("requires the member list for a question about members", () => {
    expect(requiredEvidenceFor(inGroup("这个群有哪些成员？"))).toEqual([
      {
        domain: "group_members",
        tool: "qq_group_members",
        input: { operation: "get_group_member_list" },
      },
    ]);
  });

  it("requires the notice read for a question about the notice", () => {
    expect(requiredEvidenceFor(inGroup("群公告是什么？"))).toEqual([
      {
        domain: "group_content",
        tool: "qq_group_content",
        input: { operation: "_get_group_notice" },
      },
    ]);
  });

  it("requires the essence read for a question about essence messages", () => {
    expect(requiredEvidenceFor(inGroup("群里有哪些精华消息"))).toEqual([
      {
        domain: "group_content",
        tool: "qq_group_content",
        input: { operation: "get_essence_msg_list" },
      },
    ]);
  });

  it("requires the file list for a question about group files", () => {
    expect(requiredEvidenceFor(inGroup("群文件有哪些？"))).toEqual([
      {
        domain: "group_files",
        tool: "qq_group_files",
        input: { operation: "get_group_root_files" },
      },
    ]);
  });

  it("requires the group metadata read for a question about the group profile", () => {
    expect(requiredEvidenceFor(inGroup("这个群当前资料是什么？"))).toEqual([
      { domain: "group_metadata", tool: "qq_groups", input: { operation: "get_group_info" } },
    ]);
  });

  it("requires the history page for a question about recent messages", () => {
    expect(requiredEvidenceFor(inGroup("这个群当前最新的消息是什么"))).toEqual([
      {
        domain: "group_history_page",
        tool: "qq_group_history",
        input: { operation: "get_group_msg_history" },
      },
    ]);
  });

  it("requires every domain a single message asks about, not the first one found", () => {
    expect(domains(inGroup("这个群有哪些成员和群文件？"))).toEqual([
      "group_members",
      "group_files",
    ]);
  });

  it("requires the current-group history Tool for an explicit history search", () => {
    expect(requiredEvidenceFor(inGroup("请搜索本群历史，找到 P4B-A-1349"))).toEqual([
      { domain: "group_history_search", tool: GROUP_HISTORY_SEARCH_TOOL, input: {} },
    ]);
  });

  it("never requires a group-scoped domain for a group Run's account status", () => {
    // The Run is bound to its own group, and account status is not a group-scoped read: the
    // current-group scope cannot address it.
    expect(requiredEvidenceFor(inGroup("机器人登录状态是什么"))).toEqual([]);
  });
});

describe("required evidence stays narrow", () => {
  it("requires nothing when the message only mentions a domain without asking", () => {
    expect(requiredEvidenceFor(inGroup("这个群的成员真多"))).toEqual([]);
  });

  it("requires nothing for a question about how to do something", () => {
    expect(requiredEvidenceFor(inGroup("怎么查看群成员？"))).toEqual([]);
    expect(requiredEvidenceFor(inGroup("能否查看群文件？"))).toEqual([]);
  });

  it("requires nothing for a message that changes state", () => {
    expect(requiredEvidenceFor(inGroup("把成员 10004 踢出群"))).toEqual([]);
    expect(requiredEvidenceFor(inGroup("把群名称改成 Lora 群"))).toEqual([]);
  });

  it("requires nothing when the message refuses the request", () => {
    expect(requiredEvidenceFor(inGroup("不要查看群成员"))).toEqual([]);
    expect(requiredEvidenceFor(inGroup("不用查群文件了"))).toEqual([]);
  });

  it("requires nothing for a question about the group's Glassbox policy", () => {
    // The setting that governs retrieval is Glassbox product state, read through the Owner
    // management Tool. A live history page cannot answer it.
    expect(requiredEvidenceFor(ownerPrivate("查询群 1126022432 的历史配置状态"))).toEqual([]);
    expect(requiredEvidenceFor(inGroup("群成员功能是否启用"))).toEqual([]);
  });

  it("requires nothing when the Run's own surface does not carry the Tool", () => {
    // History is disabled for this group. Requiring the Tool would fail an honest Run closed
    // against a call it cannot make.
    expect(requiredEvidenceFor(inGroup("群文件有哪些？", ["qq_groups"]))).toEqual([]);
  });

  it("requires nothing when the Run's surface is unknown", () => {
    expect(
      requiredEvidenceFor({
        text: "群文件有哪些？",
        chatType: "group",
        isOwner: false,
        authorizedToolNames: undefined,
      }),
    ).toEqual([]);
  });

  it("requires nothing for a group member who is not the Owner", () => {
    expect(
      requiredEvidenceFor({
        text: "查看群 1126022432 有哪些成员",
        chatType: "private",
        isOwner: false,
        authorizedToolNames: OWNER_SURFACE,
      }),
    ).toEqual([]);
  });
});

describe("required evidence on the Owner-private surface", () => {
  it("binds the group the message names to a live member read", () => {
    expect(requiredEvidenceFor(ownerPrivate("查看群 1126022432 有哪些成员"))).toEqual([
      {
        domain: "group_members",
        tool: "qq_group_members",
        input: { groupId: "1126022432", operation: "get_group_member_list" },
      },
    ]);
  });

  it("requires the cross-group search Tool for an explicit multi-group search", () => {
    expect(requiredEvidenceFor(ownerPrivate("搜索已授权群的历史，找 P4B-A-1349"))).toEqual([
      { domain: "owner_history_search", tool: OWNER_HISTORY_SEARCH_TOOL, input: {} },
    ]);
  });

  it("never guesses a group for a group-scoped domain the message does not name", () => {
    // Binding the read to an unnamed group would answer about the wrong Resource.
    expect(requiredEvidenceFor(ownerPrivate("群成员有哪些？"))).toEqual([]);
  });

  it("requires the account status read when the Owner asks for it", () => {
    expect(requiredEvidenceFor(ownerPrivate("机器人登录状态是什么"))).toEqual([
      {
        domain: "account_status",
        tool: "qq_account_status",
        input: { operation: "get_login_info" },
      },
    ]);
  });
});

describe("resolving required evidence against a Run's calls", () => {
  const members = requiredEvidenceFor(inGroup("这个群有哪些成员？"));

  const call = (overrides: Partial<ObservedToolCall>): ObservedToolCall => ({
    name: "qq_group_members",
    input: { operation: "get_group_member_list", params: {} },
    failed: false,
    ...overrides,
  });

  it("records the answering call and its outcome", () => {
    expect(resolveEvidence(members, [call({ toolCallId: "call-1", outcome: "success" })])).toEqual([
      {
        domain: "group_members",
        tool: "qq_group_members",
        toolCallId: "call-1",
        outcome: "success",
      },
    ]);
  });

  it("records a call that never happened as not_called", () => {
    expect(resolveEvidence(members, [])).toEqual([
      { domain: "group_members", tool: "qq_group_members", outcome: "not_called" },
    ]);
  });

  it("never counts a failed call as having observed the domain", () => {
    const failed = resolveEvidence(members, [
      call({ failed: true, outcome: "provider_unavailable", toolCallId: "call-1" }),
    ]);
    expect(failed).toEqual([
      { domain: "group_members", tool: "qq_group_members", outcome: "not_called" },
    ]);
    expect(unobservedEvidence(failed)).toHaveLength(1);
  });

  it("never counts a call that answered a different question", () => {
    // The same Tool reading a different operation is a different observation.
    expect(
      resolveEvidence(members, [call({ input: { operation: "get_group_member_info" } })]),
    ).toEqual([{ domain: "group_members", tool: "qq_group_members", outcome: "not_called" }]);
    expect(resolveEvidence(members, [call({ name: "qq_groups" })])).toEqual([
      { domain: "group_members", tool: "qq_group_members", outcome: "not_called" },
    ]);
  });

  it("keeps a domain observed when another call in the same Run answered it", () => {
    const resolutions = resolveEvidence(members, [
      call({ name: "qq_groups", failed: true }),
      call({ toolCallId: "call-2", outcome: "success" }),
    ]);
    expect(unobservedEvidence(resolutions)).toEqual([]);
    expect(resolutions[0]?.toolCallId).toBe("call-2");
  });
});

describe("whether a message asks a live QQ fact at all", () => {
  it("is true for a question about what the group contains", () => {
    expect(asksLiveQqFact("查看群 1126022432 有哪些成员")).toBe(true);
    expect(asksLiveQqFact("群公告是什么？")).toBe(true);
  });

  it("is false for a question about the group's Glassbox configuration", () => {
    // Both are answered with a Tool call, which is exactly why the management branch needs
    // this to tell them apart.
    expect(asksLiveQqFact("查看群 1126022432 的历史配置状态")).toBe(false);
    expect(asksLiveQqFact("查询群 1126022432 当前有哪些技能")).toBe(false);
  });
});
