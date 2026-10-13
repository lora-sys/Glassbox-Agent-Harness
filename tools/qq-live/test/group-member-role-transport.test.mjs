import test from "node:test";
import assert from "node:assert/strict";
import { OneBot } from "../lib/onebot.mjs";
import { socketFixture } from "./fixture.mjs";

const provider = { group_id: 20002, user_id: 10001, role: "admin", nickname: "private" };

async function fixture(t, { role = "bot", groups } = {}) {
  const calls = [];
  const server = await socketFixture((request, send) => {
    calls.push({ action: request.action, params: request.params });
    send({ echo: request.echo, status: "ok", retcode: 0, data: provider });
  });
  const config = {
    bot: { qq: "10001", wsUrl: server.url, tokenEnv: "FIXTURE_TOKEN" },
    driver: { qq: "10002", wsUrl: server.url, tokenEnv: "FIXTURE_TOKEN" },
    groups: groups ?? [
      { alias: "A", id: "20001" },
      { alias: "B", id: "20002" },
    ],
    apiTimeoutMs: 1000,
  };
  const client = new OneBot(config, role, { env: { FIXTURE_TOKEN: "fixture-token-only" } });
  t.after(async () => {
    client.close();
    await server.close();
  });
  await client.connect();
  return { client, config, calls };
}

test("fixed Bot group-role read queries only configured Bot identity in B without retaining provider fields", async (t) => {
  const { client, calls } = await fixture(t);
  assert.deepEqual(await client.readBotGroupMemberRole(), {
    groupId: "20002",
    userId: "10001",
    role: "qq_group_admin",
  });
  assert.deepEqual(calls, [
    {
      action: "get_group_member_info",
      params: { group_id: "20002", user_id: "10001", no_cache: true },
    },
  ]);
  assert.deepEqual(
    await client.call("get_group_member_info", {
      group_id: "20002",
      user_id: "10001",
      no_cache: true,
    }),
    provider,
  );
  assert.equal(calls.length, 2);
});

test("fixed role read refuses driver, missing B, or ambiguous B before a provider call", async (t) => {
  const cases = [
    { role: "driver" },
    { groups: [{ alias: "A", id: "20001" }] },
    {
      groups: [
        { alias: "A", id: "20001" },
        { alias: "B", id: "20002" },
        { alias: "B", id: "20003" },
      ],
    },
  ];
  for (const input of cases) {
    const { client, calls } = await fixture(t, input);
    await assert.rejects(client.readBotGroupMemberRole(), (error) => {
      assert.equal(error.code, "GROUP_MEMBER_ROLE_DENIED");
      assert.equal(error.status, "INCONCLUSIVE");
      return true;
    });
    assert.equal(calls.length, 0);
  }
});

test("fixed role read rejects wrong identity and unknown role without exposing provider fields", async (t) => {
  for (const data of [
    { ...provider, group_id: 20001 },
    { ...provider, user_id: 10002 },
    { ...provider, role: "moderator" },
  ]) {
    const server = await socketFixture((request, send) =>
      send({ echo: request.echo, status: "ok", retcode: 0, data }),
    );
    const config = {
      bot: { qq: "10001", wsUrl: server.url, tokenEnv: "FIXTURE_TOKEN" },
      driver: { qq: "10002", wsUrl: server.url, tokenEnv: "FIXTURE_TOKEN" },
      groups: [{ alias: "B", id: "20002" }],
      apiTimeoutMs: 1000,
    };
    const client = new OneBot(config, "bot", { env: { FIXTURE_TOKEN: "fixture-token-only" } });
    await client.connect();
    try {
      await assert.rejects(client.readBotGroupMemberRole(), (error) => {
        assert.equal(error.code, "GROUP_MEMBER_ROLE_UNAVAILABLE");
        assert.equal(error.status, "INCONCLUSIVE");
        return true;
      });
    } finally {
      client.close();
      await server.close();
    }
  }
});
