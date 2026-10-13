import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OneBot } from "../lib/onebot.mjs";
import { socketFixture } from "./fixture.mjs";

async function fixture(t, data, rejected = false) {
  const calls = [];
  const server = await socketFixture((request, send) => {
    calls.push({ action: request.action, params: request.params });
    send({
      echo: request.echo,
      status: rejected ? "failed" : "ok",
      retcode: rejected ? 403 : 0,
      data,
    });
  });
  const config = {
    bot: { qq: "10001", wsUrl: server.url, tokenEnv: "FIXTURE_TOKEN" },
    driver: { qq: "10002", wsUrl: server.url, tokenEnv: "FIXTURE_TOKEN" },
    groups: [
      { alias: "A", id: "20001" },
      { alias: "B", id: "20002" },
    ],
    apiTimeoutMs: 1000,
  };
  const bot = new OneBot(config, "bot", { env: { FIXTURE_TOKEN: "fixture-token-only" } });
  t.after(async () => {
    bot.close();
    await server.close();
  });
  await bot.connect();
  return { bot, calls, config };
}

const valid = {
  group_id: 20001,
  group_name: "fixture group",
  member_count: 3,
  max_member_count: 200,
  extra: "private provider field",
};

test("group info witness reads only Bot group A and retains a bounded digest projection", async (t) => {
  const { bot, calls } = await fixture(t, valid);
  assert.deepEqual(await bot.readGroupInfo(), {
    groupId: "20001",
    groupNameSha256: createHash("sha256").update(valid.group_name).digest("hex"),
    memberCount: 3,
    maxMemberCount: 200,
  });
  assert.deepEqual(calls, [{ action: "get_group_info", params: { group_id: "20001" } }]);
  await assert.rejects(bot.call("get_group_info", { group_id: "20001" }), {
    code: "ACTION_DENIED",
  });
  assert.equal(calls.length, 1);
});

test("group info witness rejects driver, missing A and ambiguous A before provider reads", async (t) => {
  for (const mode of ["driver", "missing", "ambiguous"]) {
    const { bot, config, calls } = await fixture(t, valid);
    if (mode === "driver") bot.role = "driver";
    if (mode === "missing") config.groups = config.groups.filter((g) => g.alias !== "A");
    if (mode === "ambiguous") config.groups.push({ alias: "A", id: "20003" });
    await assert.rejects(bot.readGroupInfo(), {
      code: "GROUP_INFO_DENIED",
      status: "INCONCLUSIVE",
    });
    assert.equal(calls.length, 0);
  }
});

test("group info witness rejects wrong identity and invalid fields without leaking or retrying", async (t) => {
  for (const data of [
    null,
    [],
    { ...valid, group_id: 20002 },
    { ...valid, group_name: "" },
    { ...valid, member_count: -1 },
    { ...valid, member_count: 201 },
    { ...valid, max_member_count: "200" },
  ]) {
    const { bot, calls } = await fixture(t, data);
    await assert.rejects(bot.readGroupInfo(), (error) => {
      assert.equal(error.code, "GROUP_INFO_UNAVAILABLE");
      assert.equal(error.status, "INCONCLUSIVE");
      assert.equal(error.message.includes(valid.group_name), false);
      assert.equal(error.message.includes(valid.extra), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
  const { bot, calls } = await fixture(t, valid, true);
  await assert.rejects(bot.readGroupInfo(), { code: "GROUP_INFO_UNAVAILABLE" });
  assert.equal(calls.length, 1);
});
