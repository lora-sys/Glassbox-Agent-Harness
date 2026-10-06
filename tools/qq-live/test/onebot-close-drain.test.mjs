import test from "node:test";
import assert from "node:assert/strict";
import { OneBot } from "../lib/onebot.mjs";

class ControlledSocket {
  constructor() {
    this.readyState = 1;
    this.listeners = new Map();
    this.closeCalls = 0;
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener, once: options.once === true });
    this.listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      entries.filter((entry) => entry.listener !== listener),
    );
  }

  listenerCount(type) {
    return (this.listeners.get(type) ?? []).length;
  }

  emit(type, event = {}) {
    const entries = [...(this.listeners.get(type) ?? [])];
    for (const entry of entries) {
      entry.listener(event);
      if (entry.once) this.removeEventListener(type, entry.listener);
    }
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 2;
  }
}

function client(apiTimeoutMs = 100) {
  const value = new OneBot(
    {
      bot: { tokenEnv: "BOT_TOKEN", qq: "10002" },
      driver: { tokenEnv: "DRIVER_TOKEN", qq: "10001" },
      apiTimeoutMs,
    },
    "bot",
  );
  const socket = new ControlledSocket();
  value.ws = socket;
  return { value, socket };
}

test("closeAndDrain waits for the socket close event and keeps subscribed observers", async () => {
  const { value, socket } = client();
  const unsubscribe = value.subscribe(() => {});
  let settled = false;
  const drain = value.closeAndDrain().then(() => {
    settled = true;
  });
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount("close"), 1);
  assert.equal(settled, false);
  assert.equal(value.listeners.size, 1);

  socket.readyState = 3;
  socket.emit("close", { code: 1000 });
  await drain;
  assert.equal(settled, true);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(value.listeners.size, 1);
  unsubscribe();
  assert.equal(value.listeners.size, 0);
});

test("closeAndDrain rejects an abnormal close and removes its temporary observer", async () => {
  const { value, socket } = client();
  const drain = value.closeAndDrain();
  assert.equal(socket.listenerCount("close"), 1);
  socket.emit("close", { code: 1006 });
  await assert.rejects(drain, { code: "WS_CLOSE_UNCONFIRMED" });
  assert.equal(socket.listenerCount("close"), 0);
});

test("closeAndDrain reports timeout when the peer never confirms closure", async () => {
  const { value, socket } = client(10);
  await assert.rejects(value.closeAndDrain(), { code: "WS_CLOSE_TIMEOUT" });
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount("close"), 0);
});

test("closeAndDrain keeps message observers active until the peer confirms closure", async () => {
  const { value, socket } = client();
  const received = [];
  value.subscribe((event) => received.push(event.message_id));
  socket.addEventListener("message", (event) => value.onFrame(event.data));
  const drain = value.closeAndDrain();

  socket.emit("message", {
    data: JSON.stringify({
      post_type: "message",
      self_id: 10002,
      message_id: 987654,
    }),
  });
  assert.deepEqual(received, [987654]);

  socket.readyState = 3;
  socket.emit("close", { code: 1000 });
  await drain;
});
