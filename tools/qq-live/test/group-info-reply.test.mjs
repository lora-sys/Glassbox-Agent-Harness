import test from "node:test";
import assert from "node:assert/strict";
import { boundMessage } from "../lib/message-binding.mjs";

const nonce = "a".repeat(32);
const reply = `QQGROUPINFO ${nonce} count=3 capacity=200`;
async function read(text = reply, overrides = {}) {
  return boundMessage(
    {
      call: async () => ({
        message_id: "30001",
        real_seq: "91",
        self_id: "10001",
        user_id: "10001",
        message_type: "private",
        time: Math.floor(Date.now() / 1000),
        message: [{ type: "text", data: { text } }],
        ...overrides,
      }),
    },
    "30001",
    {
      selfId: "10001",
      senderId: "10001",
      messageType: "private",
      afterTime: new Date().toISOString(),
      groupInfoNonce: nonce,
    },
  );
}
test("group metadata reply proves actual plain text counts without retaining the body", async () => {
  const result = await read();
  assert.deepEqual(result.groupInfo, { memberCount: 3, maxMemberCount: 200 });
  assert.equal(JSON.stringify(result).includes(reply), false);
  assert.deepEqual(
    (await read(reply, { message: reply, raw_message: reply })).groupInfo,
    result.groupInfo,
  );
});
test("group metadata reply refuses extra text, wrong marker, bad counts and hidden segments", async () => {
  for (const text of [
    reply + " group-name",
    "group-name " + reply,
    reply + "\n",
    reply.replace(nonce, "b".repeat(32)),
    reply.replace("count=3", "count=03"),
    reply.replace("count=3", "count=201"),
    reply.replace("count=3", "count=9007199254740992"),
  ]) {
    await assert.rejects(read(text), { code: "MESSAGE_BINDING_MISMATCH" });
  }
  for (const overrides of [
    { message: reply + "[CQ:image,file=private-name]" },
    {
      message: [
        { type: "text", data: { text: reply } },
        { type: "image", data: { file: "private-name" } },
      ],
    },
    { message: [{ type: "text", data: { text: reply, private: "group-name" } }] },
    { message: [{ type: "text", data: { text: reply }, extra: "group-name" }] },
    { raw_message: reply + " private-name" },
  ])
    await assert.rejects(read(reply, overrides), { code: "MESSAGE_BINDING_MISMATCH" });
});
