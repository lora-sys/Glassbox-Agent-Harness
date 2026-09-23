import { BrowserProxy } from "../browser-proxy.js";
import { dohResolveWebHost } from "../network-guard.js";

const proxy = new BrowserProxy({
  listenHost: "0.0.0.0",
  advertisedHost: "proxy",
  listenPort: 8765,
  allowWildcardListen: true,
  resolveHost: dohResolveWebHost,
});

await proxy.start();
process.stdout.write("ready\n");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void proxy.close().finally(() => process.exit(0));
  });
