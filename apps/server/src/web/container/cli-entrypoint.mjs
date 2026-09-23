import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const proxy = process.env.GLASSBOX_PROXY_SERVER;
if (proxy !== "http://proxy:8765") throw new Error("browser_proxy_missing");
const config = "/tmp/glassbox-browser-config.json";
await writeFile(
  config,
  JSON.stringify({
    browser: {
      browserName: "chromium",
      launchOptions: { proxy: { server: proxy } },
    },
  }),
);
const args = process.argv.slice(2);
const child = spawn(
  "/app/node_modules/.bin/playwright-cli",
  [...(args[1] === "open" ? [`--config=${config}`] : []), ...args],
  {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, HOME: "/tmp/home", PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright" },
  },
);
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
