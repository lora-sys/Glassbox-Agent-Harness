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

function inGroup(text: string): RequiredEvidenceInput {
  return { text, chatType: "group", isOwner: false };
}

function ownerPrivate(text: string): RequiredEvidenceInput {
  return { text, chatType: "private", isOwner: true };
}

/** The domain names required for a message, in the order the policy reports them. */
const domains = (input: RequiredEvidenceInput) =>
  requiredEvidenceFor(input).map((evidence) => evidence.domain);

describe("required web evidence", () => {
  it("requires a successful search for an explicit web research request", () => {
    expect(requiredEvidenceFor(ownerPrivate("请搜索网上最新的 Playwright CLI 资料"))).toEqual([
      { domain: "web_search", tool: "web_search", input: {} },
    ]);
  });

  it("binds an explicitly requested page read to its URL", () => {
    expect(requiredEvidenceFor(inGroup("请读取 https://example.com/docs 并总结"))).toEqual([
      { domain: "web_fetch", tool: "web_fetch", input: { url: "https://example.com/docs" } },
    ]);
  });

  it("requires a search for a current public price", () => {
    expect(domains(ownerPrivate("查一下当前官网价格"))).toEqual(["web_search"]);
  });

  it("does not mistake group history search for web search", () => {
    expect(domains(inGroup("搜索本群历史，找最新的消息"))).not.toContain("web_search");
  });
});

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

  it("requires the history Tool when an explicit sender filter comes before the history noun", () => {
    expect(
      requiredEvidenceFor(
        inGroup("请搜索发送者 QQ 3067670134 发的群历史，查找包含 P4-NOMATCH-86731 的消息。"),
      ),
    ).toEqual([{ domain: "group_history_search", tool: GROUP_HISTORY_SEARCH_TOOL, input: {} }]);
  });

  it("never requires a group-scoped domain for a group Run's account status", () => {
    // The Run is bound to its own group, and account status is not a group-scoped read: the
    // current-group scope cannot address it.
    expect(requiredEvidenceFor(inGroup("机器人登录状态是什么"))).toEqual([]);
  });
});

describe("required evidence stays narrow", () => {
  it("does not treat a speculative mention of group history as a search request", () => {
    expect(domains(inGroup("搜索一下这个文件，群历史里可能有 P4-NOMATCH-86731"))).toEqual([]);
  });

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

  it("still requires the fact when a negation is not what the message refuses", () => {
    // A negation somewhere in the message is not a refusal of it. `不要漏掉管理员` asks for the
    // list and adds an instruction about the list, and `停止维护的那些也算` narrows which files
    // count. Testing the whole message for the word deleted every requirement it made, which is
    // the one state where the Run may answer with nothing observed.
    expect(domains(inGroup("本群成员有哪些？不要漏掉管理员"))).toEqual(["group_members"]);
    expect(domains(inGroup("查一下群公告不要漏掉置顶的"))).toEqual(["group_content"]);
    expect(domains(inGroup("群文件有哪些，停止维护的那些也算"))).toEqual(["group_files"]);
  });

  it("requires the fact a yes-or-no question asks about", () => {
    // `是否` asks whether a fact holds, which is a question about the world and is answered by
    // observing it. Reading it as a question about whether something is possible required no
    // observation at all, so a Run could answer 是 or 否 with nothing behind the answer.
    expect(domains(inGroup("本群成员是否有 10004"))).toEqual(["group_members"]);
    expect(domains(ownerPrivate("群 1126022432 的成员是否包含 10004"))).toEqual(["group_members"]);
    expect(domains(inGroup("本群文件是否有新的"))).toEqual(["group_files"]);
  });

  it("still reads a question about a setting as a question about a setting", () => {
    // The other half of the rule above: `是否` asks about the world only when the world is what
    // it names. Whether the retrieval setting is on is Glassbox product state, and a live history
    // page cannot answer it, so requiring one would fail the Run closed against a read the
    // message never asked for.
    expect(domains(inGroup("本群历史检索是否已经开启？"))).toEqual([]);
    expect(domains(inGroup("群成员功能是否启用"))).toEqual([]);
  });

  it("still requires the fact a message asks for while another request instructs", () => {
    // A request that changes state speaks for itself. Reading its mutation verb as a property of
    // the message deleted the requirement the other request made, so the Run was free to answer
    // the question from the Conversation — the one state the evidence check exists to prevent.
    // It also read the instruction's own nouns as a request: 群名称 is not a question about the
    // group's profile.
    expect(domains(inGroup("把成员 10004 禁言 60 秒，另外本群有哪些成员"))).toEqual([
      "group_members",
    ]);
    expect(domains(inGroup("把群名称改成 Lora 群，然后告诉我群文件有哪些"))).toEqual([
      "group_files",
    ]);
    // The same two requests joined by a connective instead of by punctuation. A message that
    // reads the same way either way has to require the same thing.
    expect(domains(inGroup("把群名称改成 Lora 群并告诉我有哪些成员"))).toEqual(["group_members"]);
    expect(domains(inGroup("把成员 10004 踢出群顺便看看群文件"))).toEqual(["group_files"]);
  });

  it("still requires the fact a message asks for while another request asks how", () => {
    // A possibility question asks for no result, and it speaks only for itself. A message that
    // asks how to read something and, beside it, asks for the read is asking.
    expect(domains(inGroup("怎么查看群成员？另外群文件有哪些"))).toEqual(["group_files"]);
    expect(domains(inGroup("能否查看群成员？顺便看看群公告"))).toEqual(["group_content"]);
    expect(domains(inGroup("怎么查看群成员并看看群文件"))).toEqual(["group_files"]);
  });

  it("still reads a search request in a request joined to a question", () => {
    // The question asks for no result and the search beside it does. Joined by a connective
    // rather than by punctuation, the question still speaks only for itself.
    expect(domains(inGroup("怎么查看群成员并搜索本群历史找 P4B-A-1349"))).toEqual([
      "group_history_search",
    ]);
  });

  it("keeps a refusal over every request it joins", () => {
    // The one asymmetry: a refusal keeps the whole punctuation-delimited span it appears in,
    // because `不要查看群成员并查看群文件` can be read as refusing both. Reading it as refusing one
    // would have the Run read something the user refused, which is worse than requiring nothing.
    expect(domains(inGroup("不要查看群成员并查看群文件"))).toEqual([]);
  });

  it("still requires the fact a message asks for while another request asks about a setting", () => {
    expect(domains(inGroup("本群历史检索是否已经开启？另外群文件有哪些"))).toEqual(["group_files"]);
  });

  it("still reads a search request that sits beside a question about how to search", () => {
    expect(domains(inGroup("怎么搜索本群历史？另外请搜索本群历史，找到 P4B-A-1349"))).toEqual([
      "group_history_search",
    ]);
    expect(domains(ownerPrivate("怎么搜索历史？另外搜索已授权群的历史，找 P4B-A-1349"))).toEqual([
      "owner_history_search",
    ]);
  });

  it("requires nothing for a question about the group's Glassbox policy", () => {
    // The setting that governs retrieval is Glassbox product state, read through the Owner
    // management Tool. A live history page cannot answer it.
    expect(requiredEvidenceFor(ownerPrivate("查询群 1126022432 的历史配置状态"))).toEqual([]);
    expect(requiredEvidenceFor(inGroup("群成员功能是否启用"))).toEqual([]);
  });

  it("requires the domain whether or not the Run's surface carries the Tool", () => {
    // The requirement is a property of the message, not of the surface. A Run that cannot
    // observe the fact is exactly the Run most likely to state it anyway, so a requirement that
    // disappeared with the Tool would weaken the evidence check precisely where the Run can
    // observe least — and a surface that failed to resolve would require nothing at all. The
    // caller resolves the surface against the requirement; it cannot suppress it.
    expect(domains(inGroup("群文件有哪些？"))).toEqual(["group_files"]);
    expect(domains(ownerPrivate("查看群 1126022432 有哪些成员"))).toEqual(["group_members"]);
    // Nothing about the requirement is derived from a Tool list, so there is no input that
    // could withhold one.
    expect(Object.keys(inGroup("群文件有哪些？")).sort()).toEqual(["chatType", "isOwner", "text"]);
  });

  it("never also requires the live history page for an explicit history search", () => {
    // "搜索本群历史" names 历史, the page domain's own noun. A page is one group's recent
    // messages and cannot answer a search across its history, so requiring both would fail a
    // Run closed against a read the message never asked for.
    expect(domains(inGroup("请搜索本群历史，找到 P4B-A-1349，并列出原文"))).toEqual([
      "group_history_search",
    ]);
    expect(
      domains(
        ownerPrivate(
          "同时搜索我已授权的两个群历史。群 1126022432 查 P4B-A-1349。列出群号、发送者和原文，只回复到当前私聊。",
        ),
      ),
    ).toEqual(["owner_history_search"]);
  });

  it("still requires the page read when the message asks for one without a search", () => {
    // The control for the rule above: the exclusion is the search, not the word 历史.
    expect(domains(inGroup("这个群最近的历史消息有哪些？"))).toEqual(["group_history_page"]);
  });

  it("requires nothing for a group member who is not the Owner", () => {
    expect(
      requiredEvidenceFor({
        text: "查看群 1126022432 有哪些成员",
        chatType: "private",
        isOwner: false,
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

  it("binds the group the message names after dropping a request it refuses", () => {
    // The refusal drops its own request and the group binding in the request beside it survives.
    expect(
      requiredEvidenceFor(ownerPrivate("不要查看群成员，查看群 1126022432 有哪些成员")),
    ).toEqual([
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
