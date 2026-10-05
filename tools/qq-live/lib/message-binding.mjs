import { createHash } from "node:crypto";
import { LiveError, id, messageId, textOf } from "./core.mjs";

const mismatch = () => {
  throw new LiveError("MESSAGE_BINDING_MISMATCH", "消息证据与本轮输入不一致。", "INCONCLUSIVE");
};

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
  return { messageId: actualId, realSequence, time, textSha256 };
}

export function compareSameMessage(a, b) {
  if (
    !a ||
    !b ||
    a.realSequence !== b.realSequence ||
    a.time !== b.time ||
    a.textSha256 !== b.textSha256
  )
    mismatch();
  return {
    realSequence: a.realSequence,
    time: a.time,
    textSha256: a.textSha256,
  };
}
