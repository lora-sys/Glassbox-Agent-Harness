import { resolve } from "node:path";
import { LiveError } from "./core.mjs";
import { OneBot } from "./onebot.mjs";
import { verifyMessageBindings } from "./product-evidence.mjs";

function unavailable() {
  throw new LiveError(
    "HISTORY_LESSON_MESSAGE_EVIDENCE",
    "Existing QQ messages could not be independently verified for this lesson.",
    "INCONCLUSIVE",
  );
}

function matchesConfiguration(config, derived) {
  if (
    config?.bot?.qq !== derived?.bot?.qq ||
    config?.driver?.qq !== derived?.driver?.qq ||
    config?.runtime?.expectedCommit !== derived?.runtime?.expectedCommit ||
    config?.runtime?.connectionId !== derived?.runtime?.connectionId ||
    (config?.runtime?.threadId ?? null) !== (derived?.runtime?.threadId ?? null) ||
    !config?.runtime?.checkout ||
    !config?.runtime?.dataDirectory ||
    !derived?.runtime?.checkout ||
    !derived?.runtime?.dataDirectory ||
    resolve(config.runtime.checkout) !== resolve(derived.runtime.checkout) ||
    resolve(config.runtime.dataDirectory) !== resolve(derived.runtime.dataDirectory) ||
    !Array.isArray(config.groups) ||
    !Array.isArray(derived.groups) ||
    derived.groups.length === 0 ||
    new Set(derived.groups.map((group) => group.alias)).size !== derived.groups.length ||
    new Set(derived.groups.map((group) => group.id)).size !== derived.groups.length
  )
    unavailable();
  for (const group of derived.groups) {
    const matches = config.groups.filter((item) => item.alias === group.alias);
    if (matches.length !== 1 || matches[0].id !== group.id) unavailable();
  }
}

function readonlyClient(client) {
  return {
    allowMessageRead(messageId) {
      client.allowMessageRead(messageId);
    },
    call(action, parameters) {
      if (
        action !== "get_msg" ||
        !parameters ||
        Object.keys(parameters).length !== 1 ||
        !Object.hasOwn(parameters, "message_id")
      )
        unavailable();
      return client.call(action, parameters);
    },
  };
}

/** Re-read existing messages only. This adapter has no send or mutation operation. */
export function createHistoryLessonReader(config, { OneBotClass = OneBot } = {}) {
  let clients;
  let connecting;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clients?.bot.close();
    clients?.driver.close();
  };
  return {
    close,
    async readBindings(caseRecord, derived, delivery) {
      matchesConfiguration(config, derived);
      if (closed) unavailable();
      if (!connecting) {
        clients = {
          bot: new OneBotClass(config, "bot"),
          driver: new OneBotClass(config, "driver"),
        };
        connecting = (async () => {
          const results = await Promise.allSettled([
            clients.bot.connect(),
            clients.driver.connect(),
          ]);
          if (closed || results.some((result) => result.status === "rejected")) {
            close();
            unavailable();
          }
        })();
      }
      try {
        await connecting;
        if (closed) unavailable();
        return await verifyMessageBindings(
          caseRecord,
          derived,
          { bot: readonlyClient(clients.bot), driver: readonlyClient(clients.driver) },
          delivery,
        );
      } catch {
        close();
        unavailable();
      }
    },
  };
}
