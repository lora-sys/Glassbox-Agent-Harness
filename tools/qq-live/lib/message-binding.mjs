import { createHash } from "node:crypto";
import { LiveError, id, messageId, textOf } from "./core.mjs";

const mismatch = () => {
  throw new LiveError("MESSAGE_BINDING_MISMATCH", "消息证据与本轮输入不一致。", "INCONCLUSIVE");
};

function plainReply(result, text) {
  const message = result?.message;
  if (typeof message === "string") {
    if (message.includes("[CQ:") || message !== text) mismatch();
  } else if (
    !Array.isArray(message) ||
    message.length !== 1 ||
    message[0]?.type !== "text" ||
    Object.keys(message[0]).sort().join(",") !== "data,type" ||
    !message[0].data ||
    Object.keys(message[0].data).join(",") !== "text" ||
    message[0].data.text !== text
  )
    mismatch();
  if (result.raw_message !== undefined && result.raw_message !== text) mismatch();
}

export function validMessageTimeBinding(binding) {
  return (
    !!binding &&
    Number.isSafeInteger(binding.time) &&
    binding.time > 0 &&
    (!Object.hasOwn(binding, "driverTime") ||
      (Number.isSafeInteger(binding.driverTime) && binding.driverTime > 0))
  );
}

export function messageTimeBindingKeys(binding, baseKeys) {
  return Object.hasOwn(binding ?? {}, "driverTime") ? [...baseKeys, "driverTime"] : baseKeys;
}

export function messageTimesMatch(binding, evidence) {
  if (
    !validMessageTimeBinding(binding) ||
    !evidence ||
    !Number.isSafeInteger(evidence.time) ||
    evidence.time <= 0 ||
    !Number.isSafeInteger(evidence.driverTime) ||
    evidence.driverTime <= 0 ||
    binding.time !== evidence.time
  )
    return false;
  return Object.hasOwn(binding, "driverTime")
    ? binding.driverTime === evidence.driverTime
    : binding.time === evidence.driverTime;
}

export function messageReplyTimesFollowInput(input, reply) {
  return (
    validMessageTimeBinding(input) &&
    Object.hasOwn(input, "driverTime") &&
    validMessageTimeBinding(reply) &&
    Object.hasOwn(reply, "driverTime") &&
    reply.time >= input.time &&
    reply.driverTime >= input.driverTime
  );
}

export async function boundMessage(client, requestedMessageId, expected) {
  const requested = messageId(requestedMessageId);
  if (!requested) mismatch();
  const result = await client.call("get_msg", { message_id: requested });
  const actualId = messageId(result?.message_id);
  const realSequence = result?.real_seq;
  const time = result?.time;
  const freshnessFloor = Math.floor(Date.parse(expected.afterTime) / 1000) - 1;
  const freshnessCeiling = Math.floor(Date.now() / 1000) + 5;
  const text = textOf(result?.message);
  const textSha256 = createHash("sha256").update(text).digest("hex");
  const senderIds = [result?.sender?.user_id, result?.user_id].filter(
    (value) => value !== undefined && value !== null,
  );
  const contains =
    expected.contains === undefined
      ? []
      : Array.isArray(expected.contains)
        ? expected.contains
        : [expected.contains];
  const forbidden = expected.forbiddenContains === undefined ? [] : expected.forbiddenContains;
  if (
    !Array.isArray(forbidden) ||
    forbidden.length > 8 ||
    forbidden.some((part) => typeof part !== "string" || !part || part.length > 256)
  )
    mismatch();
  const forbiddenFixtureSha256 = expected.forbiddenFixtureSha256;
  if (
    forbiddenFixtureSha256 !== undefined &&
    (typeof forbiddenFixtureSha256 !== "string" || !/^[a-f0-9]{64}$/.test(forbiddenFixtureSha256))
  )
    mismatch();
  const fixtureHashes = (
    forbiddenFixtureSha256 === undefined
      ? []
      : [
          ...`${text}\n${JSON.stringify(result?.message)}`.matchAll(
            /qq-isolation-secret-[a-f0-9]{32}/gi,
          ),
        ]
  ).map(([value]) => createHash("sha256").update(value.toLowerCase(), "utf8").digest("hex"));
  if (
    (forbiddenFixtureSha256 !== undefined && fixtureHashes.includes(forbiddenFixtureSha256)) ||
    forbidden.some((part) => text.includes(part)) ||
    actualId !== requested ||
    id(result?.self_id) !== id(expected.selfId) ||
    !senderIds.length ||
    senderIds.some((senderId) => id(senderId) !== id(expected.senderId)) ||
    result?.message_type !== expected.messageType ||
    (expected.groupId !== undefined && id(result?.group_id) !== id(expected.groupId)) ||
    !Number.isSafeInteger(time) ||
    time <= 0 ||
    !Number.isFinite(freshnessFloor) ||
    time < freshnessFloor ||
    time > freshnessCeiling ||
    typeof realSequence !== "string" ||
    !/^\d{1,30}$/.test(realSequence) ||
    (expected.text !== undefined && text !== expected.text) ||
    (expected.textSha256 !== undefined && textSha256 !== expected.textSha256) ||
    contains.some((part) => typeof part !== "string" || !part || !text.includes(part))
  )
    mismatch();
  let groupInfo;
  if (expected.groupInfoNonce !== undefined) {
    if (
      typeof expected.groupInfoNonce !== "string" ||
      !/^[a-f0-9]{32}$/u.test(expected.groupInfoNonce)
    )
      mismatch();
    plainReply(result, text);
    const match =
      /^QQGROUPINFO ([a-f0-9]{32}) count=(0|[1-9]\d{0,15}) capacity=(0|[1-9]\d{0,15})$/u.exec(text);
    if (!match || match[1] !== expected.groupInfoNonce) mismatch();
    const memberCount = Number(match[2]);
    const maxMemberCount = Number(match[3]);
    if (
      !Number.isSafeInteger(memberCount) ||
      !Number.isSafeInteger(maxMemberCount) ||
      memberCount > maxMemberCount
    )
      mismatch();
    groupInfo = { memberCount, maxMemberCount };
  }
  let groupFiles;
  if (expected.groupFilesNonce !== undefined) {
    if (
      typeof expected.groupFilesNonce !== "string" ||
      !/^[a-f0-9]{32}$/u.test(expected.groupFilesNonce) ||
      expected.groupInfoNonce !== undefined
    )
      mismatch();
    plainReply(result, text);
    const match = /^QQGROUPFILES ([a-f0-9]{32}) files=(0|[1-9]\d?) folders=(0|[1-9]\d?)$/u.exec(
      text,
    );
    if (!match || match[1] !== expected.groupFilesNonce) mismatch();
    const fileCount = Number(match[2]);
    const folderCount = Number(match[3]);
    if (fileCount + folderCount > 50) mismatch();
    groupFiles = { fileCount, folderCount };
  }
  return {
    messageId: actualId,
    realSequence,
    time,
    textSha256,
    ...(groupInfo ? { groupInfo } : {}),
    ...(groupFiles ? { groupFiles } : {}),
  };
}

export function compareSameMessage(botMessage, driverMessage) {
  if (
    !botMessage ||
    !driverMessage ||
    botMessage.realSequence !== driverMessage.realSequence ||
    !Number.isSafeInteger(botMessage.time) ||
    botMessage.time <= 0 ||
    !Number.isSafeInteger(driverMessage.time) ||
    driverMessage.time <= 0 ||
    botMessage.textSha256 !== driverMessage.textSha256
  )
    mismatch();
  return {
    realSequence: botMessage.realSequence,
    time: botMessage.time,
    driverTime: driverMessage.time,
    textSha256: botMessage.textSha256,
  };
}
