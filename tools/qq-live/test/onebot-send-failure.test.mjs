import assert from "node:assert/strict";
import test from "node:test";
import { classifyOneBotSendFailure } from "../lib/onebot-send-failure.mjs";
import {
  diagnoseOneBotSendFailure,
  projectOneBotSendDiagnostic,
} from "../lib/onebot-send-diagnostic.mjs";
import { OneBot } from "../lib/onebot.mjs";
import { safeError } from "../lib/core.mjs";

const prefix =
  "EventChecker Failed: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:\n";
function response(result = -10003, errMsg = "请重新登录") {
  const message = prefix + JSON.stringify({ result, errMsg }, null, 4) + "\n";
  return { status: "failed", retcode: 1200, message, wording: message };
}

test("known native send reauthorization is classified without provider text", () => {
  for (const action of ["send_private_msg", "send_group_msg"]) {
    const receipt = classifyOneBotSendFailure(
      action,
      response(-10003, "请重新登录 private-provider-payload"),
    );
    assert.equal(receipt.kind, "ACCOUNT_REAUTH_REQUIRED");
    assert.equal(receipt.providerResult, -10003);
    assert.doesNotMatch(JSON.stringify(receipt), /private-provider-payload/u);
  }
});

test("unrelated, malformed and contradictory provider responses remain unclassified", () => {
  const valid = response();
  const cases = [
    { ...valid, status: "ok" },
    { ...valid, retcode: 0 },
    response(-1),
    response(-10003, "unrelated-private-error"),
    response(-10003, "无需重新登录"),
    response(-10003, "请勿重新登录"),
    response(-10003, "不需要重新登录"),
    { ...valid, wording: "different-private-text" },
    { ...valid, message: prefix + "not-json", wording: undefined },
    {
      ...valid,
      message:
        prefix +
        JSON.stringify({
          result: -10003,
          errMsg: "重新登录",
          extra: "private",
        }),
      wording: undefined,
    },
    { ...valid, message: valid.message + "x".repeat(4096), wording: undefined },
    {
      ...valid,
      message: valid.message.replace("sendMsg", "anotherMethod"),
      wording: undefined,
    },
  ];
  for (const item of cases)
    assert.equal(classifyOneBotSendFailure("send_private_msg", item), undefined);
  assert.equal(classifyOneBotSendFailure("get_status", valid), undefined);
});

test("OneBot rejection reports the fixed diagnosis and keeps the API failure", async () => {
  const client = new OneBot({ driver: { qq: "20002", tokenEnv: "TOKEN" } }, "driver", { env: {} });
  let rejected;
  client.pending.set("fixed-echo", {
    action: "send_private_msg",
    timer: setTimeout(() => {}, 1000),
    reject: (error) => {
      rejected = error;
    },
    resolve: () => {
      throw new Error("A rejected send cannot succeed");
    },
  });
  client.onFrame(
    JSON.stringify({
      ...response(-10003, "请重新登录 private-provider-payload"),
      echo: "fixed-echo",
    }),
  );
  assert.equal(client.pending.size, 0);
  assert.equal(rejected.code, "API_REJECTED");
  assert.match(rejected.message, /重新登录/u);
  assert.match(rejected.message, /-10003/u);
  assert.doesNotMatch(rejected.message, /private-provider-payload/u);
  assert.deepEqual(safeError(rejected).transportFailure, {
    retcode: 1200,
    classification: "ACCOUNT_REAUTH_REQUIRED",
    providerResult: -10003,
  });
  assert.deepEqual(safeError(rejected).transportDiagnostic.nativeEvent, {
    service: "NodeIKernelMsgService",
    method: "sendMsg",
    listener: "NodeIKernelMsgListener",
    event: "onMsgInfoListUpdate",
    result: -10003,
  });
  assert.equal(safeError(rejected).transportDiagnostic.action, "send_private_msg");
  assert.doesNotMatch(JSON.stringify(safeError(rejected)), /private-provider-payload/u);
});

test("safe error projection keeps an ordinary rejection retcode only", () => {
  const client = new OneBot({ driver: { qq: "20002", tokenEnv: "TOKEN" } }, "driver", { env: {} });
  let rejected;
  client.pending.set("fixed-echo", {
    action: "send_private_msg",
    timer: setTimeout(() => {}, 1000),
    reject: (error) => {
      rejected = error;
    },
    resolve: () => {
      throw new Error("A rejected send cannot succeed");
    },
  });
  client.onFrame(
    JSON.stringify({
      status: "failed",
      retcode: 77,
      message: "private-provider-payload",
      echo: "fixed-echo",
    }),
  );
  assert.deepEqual(safeError(rejected).transportFailure, { retcode: 77 });
  assert.doesNotMatch(JSON.stringify(safeError(rejected)), /private-provider-payload/u);
});

test("send diagnostic hashes bounded response text and exposes only exact native event identifiers", () => {
  const raw = response(-10003, "private-provider-payload");
  const diagnostic = diagnoseOneBotSendFailure("send_private_msg", {
    ...raw,
    echo: "secret-echo",
    data: { message_id: "secret-id" },
    privateField: "private-value",
  });
  assert.equal(diagnostic.version, 1);
  assert.deepEqual(diagnostic.responseShape, {
    status: "failed",
    retcode: "integer",
    message: "string",
    wording: "same",
    echo: "string",
    data: "object",
  });
  assert.equal(diagnostic.messageBytes, Buffer.byteLength(raw.message, "utf8"));
  assert.match(diagnostic.messageSha256, /^[a-f0-9]{64}$/u);
  assert.equal(diagnostic.messageForm, "native-event-json");
  assert.equal(diagnostic.nativeErrMsgClassification, "unrecognized");
  const serialized = JSON.stringify(diagnostic);
  for (const secret of [
    "private-provider-payload",
    "secret-echo",
    "secret-id",
    "private-value",
    "重新登录",
  ])
    assert.ok(!serialized.includes(secret));
});

test("native diagnostic classifies the private error text without changing send classification", () => {
  const cases = [
    ["请重新登录", "recognized", true],
    ["无需重新登录", "contradictory", false],
    ["请重新登录，但不需要重新登录", "contradictory", false],
    ["rich media transfer failed", "unrecognized", false],
  ];
  for (const [errMsg, expected, isReauth] of cases) {
    const responseValue = response(-10003, errMsg);
    const diagnostic = diagnoseOneBotSendFailure("send_private_msg", responseValue);
    assert.equal(diagnostic.nativeErrMsgClassification, expected);
    assert.equal(
      classifyOneBotSendFailure("send_private_msg", responseValue)?.kind,
      isReauth ? "ACCOUNT_REAUTH_REQUIRED" : undefined,
    );
    const serialized = JSON.stringify(diagnostic);
    assert.equal(serialized.includes(errMsg), false);
    assert.equal(serialized.includes("errMsg"), false);
  }
});

test("diagnostic projection validates the enum and keeps legacy native receipts readable", () => {
  const diagnostic = diagnoseOneBotSendFailure(
    "send_private_msg",
    response(-10003, "unrelated-provider-text"),
  );
  assert.equal(diagnostic.nativeErrMsgClassification, "unrecognized");
  assert.equal(
    projectOneBotSendDiagnostic({
      ...diagnostic,
      nativeErrMsgClassification: "private-provider-text",
    }),
    undefined,
  );
  assert.equal(
    projectOneBotSendDiagnostic({
      ...diagnostic,
      nativeErrMsgClassification: undefined,
    }),
    undefined,
  );
  assert.equal(
    projectOneBotSendDiagnostic({
      ...diagnostic,
      errMsg: "private-provider-text",
    }),
    undefined,
  );

  const legacy = Object.fromEntries(
    Object.entries(diagnostic).filter(([key]) => key !== "nativeErrMsgClassification"),
  );
  assert.equal(
    Object.hasOwn(projectOneBotSendDiagnostic(legacy), "nativeErrMsgClassification"),
    false,
  );
});

test("malformed and adversarial response fields remain payload-free and unclassified", () => {
  const cases = [
    {
      status: "failed",
      retcode: 1200,
      message: "private error text",
      wording: "different secret",
    },
    { status: "failed", retcode: 1200, message: prefix + "{secret" },
    {
      status: "failed",
      retcode: 1200,
      message: prefix + JSON.stringify({ result: -10003, errMsg: "secret", extra: "private" }),
    },
    {
      status: "failed",
      retcode: 1200,
      message: { secret: "private" },
      wording: 12,
      echo: ["private"],
    },
    { status: "failed", retcode: "1200", message: "x".repeat(9000) },
  ];
  for (const responseValue of cases) {
    const diagnostic = diagnoseOneBotSendFailure("send_private_msg", responseValue);
    assert.ok(diagnostic);
    const serialized = JSON.stringify(diagnostic);
    for (const payload of ["private error text", "different secret", "secret", '"private"'])
      assert.equal(serialized.includes(payload), false);
    assert.equal(classifyOneBotSendFailure("send_private_msg", responseValue), undefined);
    assert.equal(projectOneBotSendDiagnostic({ ...diagnostic, rawMessage: "private" }), undefined);
  }
  const large = diagnoseOneBotSendFailure("send_private_msg", cases[4]);
  assert.equal(large.messageBytes, 9000);
  assert.equal(Object.hasOwn(large, "messageSha256"), false);
});

test("diagnostic rejects accessor fields and a native event wrapper not in the pinned contract", () => {
  const accessor = { version: 1, action: "send_private_msg" };
  Object.defineProperty(accessor, "messageBytes", {
    enumerable: true,
    get() {
      throw new Error("secret getter");
    },
  });
  assert.equal(projectOneBotSendDiagnostic(accessor), undefined);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("secret proxy");
      },
    },
  );
  assert.equal(projectOneBotSendDiagnostic(proxy), undefined);
  const wrapper = {
    status: "failed",
    retcode: 1200,
    message: "Error: " + prefix + JSON.stringify({ result: -10003, errMsg: "请重新登录" }),
  };
  const diagnostic = diagnoseOneBotSendFailure("send_private_msg", wrapper);
  assert.equal(diagnostic.messageForm, "other");
  assert.equal(Object.hasOwn(diagnostic, "nativeEvent"), false);
  assert.equal(classifyOneBotSendFailure("send_private_msg", wrapper), undefined);
});
