/**
 * The one source of the fixed replies a gate returns without (or instead of) the model.
 *
 * These used to be string literals scattered through run-adapter.ts, so the same class of
 * refusal could be worded two ways depending on which path produced it, and a wording change
 * meant editing gate logic. The server may override these defaults per runtime profile through
 * runtime-replies.json. Both the model prompt and server gates use the same resolved snapshot.
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
  imageReadFailed: "图片读取失败，暂时无法识别，请重新发送图片。",
  imageModelUnsupported:
    "当前配置的模型不支持识别图片，因此没有发送图片。请切换到支持视觉输入的模型后重试。",
  moderationParametersMissing: "请在禁言指令中明确指定目标群号、成员及禁言时长。未执行禁言。",
  moderationWrongGroup: "群聊中的禁言请求只能针对当前群，请在目标群重新发起请求。未执行禁言。",
  modelToolUnavailable: "模型切换工具当前不可用，未执行。",
  contextOverflow: "当前请求超过已配置模型的上下文容量，未发送给模型。",
  sourceAuthorityChanged: "来源授权已变化，已停止继续请求模型。",
  requiredActionMissing: "请求的操作未执行，请稍后重试。",
  browserEvidenceMissing: "浏览器操作未完成，无法确认页面或提供截图。",
  webEvidenceMissing: "网页检索或读取未完成，因此无法确认。",
  qqEvidenceMissing: "未能从 QQ 获取该信息，因此无法确认。",
  qqFieldsMissing: "未能从 QQ 获取完整的请求字段，因此无法确认。",
} as const;

export type GateMessageKey = keyof typeof GATE_MESSAGES;
export type GateMessages = Readonly<Record<GateMessageKey, string>>;

// Transport, capacity and missing-evidence fallbacks run after or instead of the model. Their
// text remains configurable but does not need to occupy every model request's context.
const MODEL_REPLY_KEYS: readonly GateMessageKey[] = [
  "mediaClarify",
  "mediaGroupDisabled",
  "mediaNotAuthorized",
  "modelUnknownTarget",
  "notPermittedInGroup",
  "notPermitted",
  "incompleteParameters",
  "identityNotChangedBySelfClaim",
  "ownerDecidesConduct",
  "claimedChangeNotPerformed",
];

export function gateReplyClause(messages: GateMessages): string {
  const modelReplies = Object.fromEntries(MODEL_REPLY_KEYS.map((key) => [key, messages[key]]));
  return `\n\nServer-selected refusal wording: ${JSON.stringify(modelReplies)}. When a listed refusal applies, use its exact wording instead of a different canned reply. This changes wording only, never identity, authorization, or Tool availability.`;
}
