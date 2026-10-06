import test from "node:test";
import assert from "node:assert/strict";
import { projectGroupFiles } from "../lib/group-files-evidence.mjs";
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
  files: [
    { group_id: 20001, file_id: "fixture-file", file_name: "fixture private file", file_size: 12 },
  ],
  folders: [],
};
test("group root page witness reads only Bot group A and retains a bounded digest projection", async (t) => {
  const { bot, calls } = await fixture(t, valid);
  assert.deepEqual(await bot.readGroupRootFiles(), projectGroupFiles(valid, "20001"));
  assert.deepEqual(calls, [{ action: "get_group_root_files", params: { group_id: "20001" } }]);
  await assert.rejects(bot.call("get_group_root_files", { group_id: "20001" }), {
    code: "ACTION_DENIED",
  });
  assert.equal(calls.length, 1);
});

test("group root page witness rejects driver, missing A and ambiguous A before provider reads", async (t) => {
  for (const mode of ["driver", "missing", "ambiguous"]) {
    const { bot, config, calls } = await fixture(t, valid);
    if (mode === "driver") bot.role = "driver";
    if (mode === "missing") config.groups = config.groups.filter((g) => g.alias !== "A");
    if (mode === "ambiguous") config.groups.push({ alias: "A", id: "20003" });
    await assert.rejects(bot.readGroupRootFiles(), {
      code: "GROUP_FILES_DENIED",
      status: "INCONCLUSIVE",
    });
    assert.equal(calls.length, 0);
  }
});

test("group root page witness rejects wrong identity and invalid fields without leaking or retrying", async (t) => {
  for (const data of [
    null,
    [],
    { files: [], folders: null },
    { files: [{ ...valid.files[0], group_id: 20002 }], folders: [] },
    { files: [{ ...valid.files[0], file_id: "" }], folders: [] },
    { files: [{ ...valid.files[0], file_size: -1 }], folders: [] },
    { files: [valid.files[0], valid.files[0]], folders: [] },
  ]) {
    const { bot, calls } = await fixture(t, data);
    await assert.rejects(bot.readGroupRootFiles(), (error) => {
      assert.equal(error.code, "GROUP_FILES_UNAVAILABLE");
      assert.equal(error.status, "INCONCLUSIVE");
      assert.equal(error.message.includes(valid.files[0].file_name), false);

      return true;
    });
    assert.equal(calls.length, 1);
  }
  const { bot, calls } = await fixture(t, valid, true);
  await assert.rejects(bot.readGroupRootFiles(), { code: "GROUP_FILES_UNAVAILABLE" });
  assert.equal(calls.length, 1);
});
