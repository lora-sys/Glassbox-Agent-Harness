import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "./cli/main.js";
import { CliError } from "./cli/errors.js";
import { getServiceDataDir } from "./platform/paths.js";
import { serverPort } from "./config/server-port.js";

process.exitCode = await main(process.argv.slice(2), {
  resolveConnection: async () => {
    const token = (await readFile(join(getServiceDataDir(), "management-token"), "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new CliError("AUTH_REQUIRED");
    return { baseUrl: `http://127.0.0.1:${serverPort()}`, token };
  },
  startServer: async () => {
    const { startServer } = await import("./index.js");
    return startServer({ quiet: true });
  },
});
