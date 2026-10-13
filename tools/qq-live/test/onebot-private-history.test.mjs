import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../lib/core.mjs";
import { OneBot } from "../lib/onebot.mjs";
import { baseConfig } from "./fixture.mjs";

const env = {
  DRIVER_TOKEN: "fixture-token-only",
  BOT_TOKEN: "fixture-token-only",
};

function historyRecord(config, overrides = {}) {
  const text = "bounded private record";
  return {
    self_id: Number(config.driver.qq),
    user_id: Number(config.driver.qq),
    sender: { user_id: Number(config.driver.qq) },
    message_type: "private",
    message_id: 123456,
    time: 1791376248,
    real_seq: "615",
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    ...overrides,
  };
}

function mediaHistoryRecord(config, account, messageId, overrides = {}) {
  const text = "视频已生成";
  return {
    self_id: Number(account),
    user_id: Number(account === config.driver.qq ? config.bot.qq : config.driver.qq),
    sender: { user_id: Number(config.bot.qq) },
    message_type: "private",
    message_id: Number(messageId),
    time: Math.floor(Date.now() / 1000),
    real_seq: "808",
    message: [
      { type: "text", data: { text } },
      { type: "image", data: { file: "private-locator-must-not-escape" } },
    ],
    raw_message: `${text}[CQ:image,file=private-locator-must-not-escape]`,
    ...overrides,
  };
}

function attachResponse(client, handler) {
  client.ws = {
    readyState: 1,
    send(payload) {
      const request = JSON.parse(payload);
      queueMicrotask(() => {
        const response = handler(request);
        client.onFrame(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: response,
            echo: request.echo,
          }),
        );
      });
    },
  };
}

test("Owner private-history read fixes the Bot peer, caps the query and returns sanitized rows", async () => {
  const config = baseConfig();
  const client = new OneBot(config, "driver", { env });
  const raw = historyRecord(config);
  let requested;
  attachResponse(client, (request) => {
    requested = request;
    return { messages: [raw] };
  });

  const receipt = await client.readOwnerBotPrivateHistory();

  assert.equal(requested.action, "get_friend_msg_history");
  assert.deepEqual(requested.params, {
    user_id: config.bot.qq,
    count: 20,
    reverse_order: true,
    disable_get_url: true,
    parse_mult_msg: false,
  });
  assert.equal(receipt.accountIdentity, config.driver.qq);
  assert.equal(receipt.peerId, config.bot.qq);
  assert.deepEqual(receipt.messages, [
    {
      messageId: "123456",
      selfId: config.driver.qq,
      senderId: config.driver.qq,
      userId: config.driver.qq,
      messageType: "private",
      time: 1791376248,
      realSequence: "615",
      textBytes: Buffer.byteLength("bounded private record"),
      textSha256: digest("bounded private record"),
      segmentTypes: ["text"],
    },
  ]);
  assert.equal(JSON.stringify(receipt).includes("bounded private record"), false);
  assert.equal(JSON.stringify(receipt).includes("raw_message"), false);
});

test("Bot private-history read fixes the Owner peer, caps the query and returns sanitized rows", async () => {
  const config = baseConfig();
  const client = new OneBot(config, "bot", { env });
  const raw = {
    ...historyRecord(config),
    self_id: Number(config.bot.qq),
    user_id: Number(config.driver.qq),
    sender: { user_id: Number(config.bot.qq) },
  };
  let requested;
  attachResponse(client, (request) => {
    requested = request;
    return { messages: [raw] };
  });

  const receipt = await client.readBotOwnerPrivateHistory();

  assert.equal(requested.action, "get_friend_msg_history");
  assert.deepEqual(requested.params, {
    user_id: config.driver.qq,
    count: 20,
    reverse_order: true,
    disable_get_url: true,
    parse_mult_msg: false,
  });
  assert.equal(receipt.accountIdentity, config.bot.qq);
  assert.equal(receipt.peerId, config.driver.qq);
  assert.deepEqual(receipt.messages, [
    {
      messageId: "123456",
      selfId: config.bot.qq,
      senderId: config.bot.qq,
      userId: config.driver.qq,
      messageType: "private",
      time: 1791376248,
      realSequence: "615",
      textBytes: Buffer.byteLength("bounded private record"),
      textSha256: digest("bounded private record"),
      segmentTypes: ["text"],
    },
  ]);
  assert.equal(JSON.stringify(receipt).includes("bounded private record"), false);
  assert.equal(JSON.stringify(receipt).includes("raw_message"), false);
});

test("only Bot may read its fixed Owner peer history and generic history calls remain denied", async () => {
  const config = baseConfig();
  const driver = new OneBot(config, "driver", { env });
  await assert.rejects(driver.readBotOwnerPrivateHistory(), {
    code: "PRIVATE_HISTORY_DENIED",
  });

  const bot = new OneBot(config, "bot", { env });
  await assert.rejects(
    bot.call("get_friend_msg_history", {
      user_id: config.driver.qq,
      count: 20,
    }),
    { code: "ACTION_DENIED" },
  );
  assert.throws(
    () =>
      bot.authorize("get_friend_msg_history", {
        user_id: config.driver.qq,
        count: 20,
      }),
    { code: "ACTION_DENIED" },
  );
});

test("Bot private-history read rejects mismatched account or peer and oversized pages", async () => {
  const config = baseConfig();
  const invalidRows = [
    {
      ...historyRecord(config),
      self_id: Number(config.driver.qq),
      user_id: Number(config.driver.qq),
      sender: { user_id: Number(config.driver.qq) },
    },
    {
      ...historyRecord(config),
      self_id: Number(config.bot.qq),
      user_id: 999999999,
      sender: { user_id: Number(config.bot.qq) },
    },
    {
      ...historyRecord(config),
      self_id: Number(config.bot.qq),
      user_id: Number(config.driver.qq),
      sender: { user_id: Number(config.bot.qq) },
      message_type: "group",
    },
    {
      ...historyRecord(config),
      self_id: Number(config.bot.qq),
      user_id: Number(config.driver.qq),
      sender: { user_id: Number(config.bot.qq) },
      message: [{ type: "image", data: { file: "private" } }],
    },
  ];
  for (const row of invalidRows) {
    const client = new OneBot(config, "bot", { env });
    attachResponse(client, () => ({ messages: [row] }));
    await assert.rejects(client.readBotOwnerPrivateHistory(), {
      code: "PRIVATE_HISTORY_INVALID",
    });
  }
  const empty = new OneBot(config, "bot", { env });
  attachResponse(empty, () => ({ messages: [] }));
  await assert.rejects(empty.readBotOwnerPrivateHistory(), {
    code: "PRIVATE_HISTORY_INVALID",
  });

  const oversized = new OneBot(config, "bot", { env });
  attachResponse(oversized, () => ({
    messages: Array.from({ length: 21 }, () => ({
      ...historyRecord(config),
      self_id: Number(config.bot.qq),
      user_id: Number(config.driver.qq),
      sender: { user_id: Number(config.bot.qq) },
    })),
  }));
  await assert.rejects(oversized.readBotOwnerPrivateHistory(), {
    code: "PRIVATE_HISTORY_INVALID",
  });
});

test("only the Driver may read this fixed Bot peer history", async () => {
  const config = baseConfig();
  const bot = new OneBot(config, "bot", { env });
  await assert.rejects(bot.readOwnerBotPrivateHistory(), {
    code: "PRIVATE_HISTORY_DENIED",
  });

  const driver = new OneBot(config, "driver", { env });
  await assert.rejects(
    driver.call("get_friend_msg_history", {
      user_id: config.bot.qq,
      count: 20,
    }),
    { code: "ACTION_DENIED" },
  );
  assert.throws(
    () =>
      driver.authorize("get_friend_msg_history", {
        user_id: config.driver.qq,
        count: 20,
      }),
    { code: "ACTION_DENIED" },
  );
});

test("history response rejects another account, group rows, rich segments and oversized pages", async (t) => {
  const config = baseConfig();
  const malformed = [
    historyRecord(config, { self_id: Number(config.bot.qq) }),
    historyRecord(config, { message_type: "group" }),
    historyRecord(config, {
      message: [{ type: "image", data: { file: "private" } }],
    }),
  ];
  for (const row of malformed) {
    const client = new OneBot(config, "driver", { env });
    attachResponse(client, () => ({ messages: [row] }));
    await assert.rejects(client.readOwnerBotPrivateHistory(), {
      code: "PRIVATE_HISTORY_INVALID",
    });
  }
  const oversized = new OneBot(config, "driver", { env });
  attachResponse(oversized, () => ({
    messages: Array.from({ length: 21 }, () => historyRecord(config)),
  }));
  await assert.rejects(oversized.readOwnerBotPrivateHistory(), {
    code: "PRIVATE_HISTORY_INVALID",
  });
  const empty = new OneBot(config, "driver", { env });
  attachResponse(empty, () => ({ messages: [] }));
  await assert.rejects(empty.readOwnerBotPrivateHistory(), {
    code: "PRIVATE_HISTORY_INVALID",
  });
  const expanded = new OneBot(config, "driver", { env });
  attachResponse(expanded, () => ({
    messages: [historyRecord(config)],
    extra: true,
  }));
  await assert.rejects(expanded.readOwnerBotPrivateHistory(), {
    code: "PRIVATE_HISTORY_INVALID",
  });
});

test("fixed media-history reads expose only bounded metadata for the configured peer", async () => {
  const config = baseConfig();
  const expected = {
    mediaType: "image",
    captionSha256: digest("视频已生成"),
    afterTime: new Date((Math.floor(Date.now() / 1000) - 1) * 1000).toISOString(),
  };
  const driver = new OneBot(config, "driver", { env });
  let request;
  attachResponse(driver, (value) => {
    request = value;
    return { messages: [mediaHistoryRecord(config, config.driver.qq, "704")] };
  });
  const driverReceipt = await driver.readOwnerBotPrivateMediaHistory(expected);
  assert.equal(request.action, "get_friend_msg_history");
  assert.deepEqual(request.params, {
    user_id: config.bot.qq,
    count: 20,
    reverse_order: true,
    disable_get_url: true,
    parse_mult_msg: false,
  });
  assert.deepEqual(driverReceipt, {
    accountIdentity: config.driver.qq,
    peerId: config.bot.qq,
    messages: [
      {
        messageId: "704",
        selfId: config.driver.qq,
        senderId: config.bot.qq,
        userId: config.bot.qq,
        messageType: "private",
        time: driverReceipt.messages[0].time,
        realSequence: "808",
        textBytes: Buffer.byteLength("视频已生成"),
        textSha256: digest("视频已生成"),
        mediaType: "image",
        mediaLocatorPresent: true,
        segmentCount: 2,
        segmentTypes: ["text", "image"],
      },
    ],
  });
  assert.equal(JSON.stringify(driverReceipt).includes("视频已生成"), false);
  assert.equal(JSON.stringify(driverReceipt).includes("private-locator"), false);

  const bot = new OneBot(config, "bot", { env });
  attachResponse(bot, () => ({
    messages: [mediaHistoryRecord(config, config.bot.qq, "705")],
  }));
  const botReceipt = await bot.readBotOwnerPrivateMediaHistory(expected);
  assert.equal(botReceipt.accountIdentity, config.bot.qq);
  assert.equal(botReceipt.peerId, config.driver.qq);
  assert.equal(botReceipt.messages[0].messageId, "705");
  assert.equal(botReceipt.messages[0].senderId, config.bot.qq);
  assert.equal(JSON.stringify(botReceipt).includes("private-locator"), false);
});

test("fixed media-history rejects malformed or unbounded media rows and never widens action access", async () => {
  const config = baseConfig();
  const expected = {
    mediaType: "image",
    captionSha256: digest("视频已生成"),
    afterTime: new Date((Math.floor(Date.now() / 1000) - 1) * 1000).toISOString(),
  };
  const badRows = [
    mediaHistoryRecord(config, config.driver.qq, "704", {
      message_type: "group",
    }),
    mediaHistoryRecord(config, config.driver.qq, "704", {
      message: [{ type: "image", data: { file: "private" } }],
    }),
    mediaHistoryRecord(config, config.driver.qq, "704", {
      message: [
        { type: "text", data: { text: "视频已生成" } },
        { type: "image", data: {} },
      ],
    }),
    mediaHistoryRecord(config, config.bot.qq, "704"),
  ];
  for (const row of badRows) {
    const client = new OneBot(config, "driver", { env });
    attachResponse(client, () => ({ messages: [row] }));
    await assert.rejects(client.readOwnerBotPrivateMediaHistory(expected), {
      code: "PRIVATE_MEDIA_HISTORY_INVALID",
    });
  }
  const oversized = new OneBot(config, "driver", { env });
  attachResponse(oversized, () => ({
    messages: Array.from({ length: 21 }, (_, index) =>
      mediaHistoryRecord(config, config.driver.qq, String(700 + index)),
    ),
  }));
  await assert.rejects(oversized.readOwnerBotPrivateMediaHistory(expected), {
    code: "PRIVATE_MEDIA_HISTORY_INVALID",
  });
  await assert.rejects(
    oversized.call("get_friend_msg_history", {
      user_id: config.bot.qq,
      count: 20,
    }),
    { code: "ACTION_DENIED" },
  );
});
