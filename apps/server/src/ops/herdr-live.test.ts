import { expect, it } from "vite-plus/test";
import { SocketHerdrBridge } from "./socket-herdr-bridge.js";

// Opt in only against the dedicated integration session. No workspace mutation.
it.skipIf(!process.env.GLASSBOX_TEST_HERDR_SOCKET)(
  "connects, snapshots and subscribes to a real Herdr server",
  async () => {
    const bridge = new SocketHerdrBridge({
      socketPath: process.env.GLASSBOX_TEST_HERDR_SOCKET!,
      sessionId: "glassbox-p3",
      requestTimeoutMs: 5000,
    });
    try {
      await bridge.connect();
      const snapshot = await bridge.getSnapshot();
      expect(snapshot.sessionId).toBe("glassbox-p3");
      expect(Array.isArray(snapshot.workspaces)).toBe(true);
      const subscription = await bridge.subscribe(() => {});
      expect(subscription.subscriptionId).toBeTruthy();
      expect(bridge.isConnected()).toBe(true);
      bridge.unsubscribe(subscription.subscriptionId);
    } finally {
      await bridge.disconnect();
    }
  },
  15_000,
);
