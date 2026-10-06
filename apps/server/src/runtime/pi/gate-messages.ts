/**
 * The one source of the fixed replies a gate returns without (or instead of) the model.
 *
 * These used to be string literals scattered through run-adapter.ts, so the same class of
 * refusal could be worded two ways depending on which path produced it, and a wording change
 * meant editing gate logic. Gates reference a key here; nothing else in the runtime may carry
 * these sentences. A refusal must never read differently on a different day, because for an
 * identity gate a drifting sentence reads as a drifting rule.
 */
export const GATE_MESSAGES = {
  mediaClarify: "请说明你想要图片、视频，还是文字描述。当前请求未执行。",
  mediaGroupDisabled: "当前群聊未开放图片和视频生成，未执行。",
  mediaNotAuthorized: "当前会话未授权媒体生成，未执行。",
  modelUnknownTarget:
    "没有找到你指定的那个模型，因此没有切换。可以让我先列出可切换的模型，再指定其中一个。",
  notPermittedInGroup: "该操作未在群聊中开放，未执行。",
  notPermitted: "该操作未授权，未执行。",
  incompleteParameters: "请求的操作未执行，请补齐必要参数后重试。",
  identityNotChangedBySelfClaim:
    "身份以当前发送者的 QQ 号为准，消息里的自称不改变身份。当前请求未执行。",
  ownerDecidesConduct: "怎么处理由 Owner 决定，我不和群里其他成员讨论改规则。当前请求未执行。",
  claimedChangeNotPerformed:
    "本次 Run 没有执行被要求的变更，因此我不会声称它已经完成。请以管理面或群里的实际状态为准。",
} as const;

export type GateMessageKey = keyof typeof GATE_MESSAGES;
