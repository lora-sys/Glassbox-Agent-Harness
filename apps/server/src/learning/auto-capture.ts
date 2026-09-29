/**
 * Conservative signal classifier for a single current user message.
 *
 * This module only describes a pending candidate. Callers remain responsible for
 * authorization, persistence, deduplication, and review. It never activates Memory.
 */
export type AutoCaptureScope =
  | { type: "private" }
  | { type: "group"; connectionId: string; botId: string; groupId: string };

export interface AutoCaptureInput {
  text: string;
  actor: "owner" | "visitor" | "unknown";
  role: "user" | "assistant" | "system" | "tool";
  scope: AutoCaptureScope;
  origin: "current_message" | "quoted" | "retrieved";
  /** Stable Trace/message reference, when available. Never interpreted as content. */
  messageRef?: string;
}

export interface AutoCaptureCandidate {
  status: "pending";
  type: "preference" | "semantic_fact";
  scope:
    | { type: "global" }
    | { type: "group"; connectionId: string; botId: string; groupId: string };
  statement: string;
  confidence: 0.9;
  evidence: {
    kind: "explicit_preference" | "explicit_correction" | "explicit_remember" | "group_relevance";
    source: "current_message";
    messageRef?: string;
  };
}

const maxStatementLength = 240;
const maxScopeIdentifierLength = 128;
const scopeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const secretPattern =
  /(?:\b(?:password|passphrase|secret|api[ _-]?key|access[ _-]?token|bearer|private[ _-]?key|credential)\b|密码|口令|密钥|令牌|访问令牌|私钥|凭据|验证码)/iu;
const quotePrefixPattern = /^(?:>|“|"|'|「|『|\[quote\])/u;
const quoteMarkPattern = /[“”"'「」『』]/u;
const codeOrUrlPattern = /(?:```|`|https?:\/\/|www\.)/iu;

const preferencePattern =
  /(?:我(?:一直|始终|总是)?(?:更)?(?:喜欢|偏好|倾向于)|我更正一下[，,:：]?\s*我(?:更)?(?:喜欢|偏好)|(?:以后|今后)?请(?:始终|总是)?)(.+)$/iu;
const preferenceVerbPattern =
  /(?:我(?:一直|始终|总是)?(?:更)?(?:喜欢|偏好|倾向于)|我更正一下[，,:：]?\s*我(?:更)?(?:喜欢|偏好)|(?:以后|今后)?请(?:始终|总是)?)/iu;
const explicitRememberPattern =
  /^(?:(?:全局)?(?:请)?(?:记住|记下|保存|存下|加入记忆|写入记忆|记入)(?:这个群的)?(?:记忆|这件事|这个事实|以下内容)?|请(?:在)?(?:这个群|本群)(?:里|中)?(?:记住|记下|保存|存下|记入记忆))(?:[，,:：]\s*|\s+)(.+)$/iu;
const groupRelevancePattern =
  /(?:这个群|本群|群里|群聊|在群中|this group|the group|in this group)/iu;
const groupMemoryRequestPattern =
  /(?:记住|记下|保存|存下|加入记忆|写入记忆).{0,24}(?:这个群|本群|群里|群聊|group)|(?:这个群|本群|群里|群聊|group).{0,24}(?:记住|记下|保存|存下|记忆)/iu;
const groupResponsePreferencePattern =
  /(?:本群|这个群|群里).{0,12}(?:回答|回复|答复)(?:问题)?时(?:先|优先|必须|应该|需要|尽量|不要|避免)/u;

/** Return a pending descriptor only for explicit, safe, user-authored signals. */
export function classifyAutoCapture(input: AutoCaptureInput): AutoCaptureCandidate | undefined {
  if (input.actor !== "owner" || input.role !== "user" || input.origin !== "current_message")
    return;
  if (
    input.scope.type === "group" &&
    ![input.scope.connectionId, input.scope.botId, input.scope.groupId].every(
      isValidScopeIdentifier,
    )
  )
    return;

  const text = input.text.trim();
  if (
    !text ||
    text.length > maxStatementLength ||
    quotePrefixPattern.test(text) ||
    secretPattern.test(text) ||
    codeOrUrlPattern.test(text)
  )
    return;

  const isGroup = input.scope.type === "group";
  const groupPrefix = /^(?:在这个群里|在本群|本群里|这个群里|群里|在群里)[，,:：]?\s*/iu;
  const signalText = isGroup ? text.replace(groupPrefix, "") : text;
  const explicitRemember = explicitRememberPattern.exec(signalText);
  const preference = preferencePattern.exec(signalText);
  const rememberedText = explicitRemember?.[1]?.trim();
  const rememberedPreference = rememberedText ? preferencePattern.exec(rememberedText) : undefined;
  const rememberedGroupResponsePreference = Boolean(
    isGroup && rememberedText && groupResponsePreferencePattern.test(rememberedText),
  );
  const isPreferenceSignal = Boolean(
    (rememberedPreference && preferenceVerbPattern.test(rememberedText ?? "")) ||
    rememberedGroupResponsePreference ||
    (!explicitRemember && preference && preferenceVerbPattern.test(signalText)),
  );
  if (
    !isGroup &&
    groupRelevancePattern.test(text) &&
    (explicitRemember || isPreferenceSignal || groupMemoryRequestPattern.test(text))
  )
    return;

  if (input.scope.type === "group") {
    const groupExplicit = groupRelevancePattern.test(text) || groupMemoryRequestPattern.test(text);
    if (!groupExplicit || (!explicitRemember && !isPreferenceSignal)) return;
  } else {
    if (!explicitRemember && !isPreferenceSignal) return;
  }

  const kind = isPreferenceSignal
    ? rememberedGroupResponsePreference
      ? "explicit_preference"
      : preferenceVerbPattern.test(text)
        ? /更正一下|correct(?:ion)?/iu.test(text)
          ? "explicit_correction"
          : "explicit_preference"
        : "group_relevance"
    : "explicit_remember";
  const extracted = (
    isPreferenceSignal
      ? rememberedGroupResponsePreference
        ? rememberedText
        : (rememberedPreference?.[1] ?? preference?.[1])
      : explicitRemember?.[1]
  )?.trim();
  if (!extracted) return;

  const statement = extracted
    .replace(/[。.!！?？]+$/u, "")
    .trim()
    .slice(0, maxStatementLength);
  if (
    !statement ||
    secretPattern.test(statement) ||
    quotePrefixPattern.test(statement) ||
    quoteMarkPattern.test(statement) ||
    codeOrUrlPattern.test(statement)
  )
    return;

  const messageRef = input.messageRef?.trim().slice(0, 160);
  return {
    status: "pending",
    type: isPreferenceSignal ? "preference" : "semantic_fact",
    scope:
      input.scope.type === "group"
        ? {
            type: "group",
            connectionId: input.scope.connectionId,
            botId: input.scope.botId,
            groupId: input.scope.groupId,
          }
        : { type: "global" },
    statement,
    confidence: 0.9,
    evidence: {
      kind,
      source: "current_message",
      ...(messageRef ? { messageRef } : {}),
    },
  };
}

function isValidScopeIdentifier(value: string): boolean {
  return value.length <= maxScopeIdentifierLength && scopeIdentifierPattern.test(value);
}
