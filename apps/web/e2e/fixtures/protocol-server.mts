import { join, isAbsolute } from "node:path";
import { startServer } from "../../../server/src/index.js";

const dataDirectory = process.env.GLASSBOX_DATA_DIR;
if (!dataDirectory || !isAbsolute(dataDirectory))
  throw new Error("Isolated data directory required");
const result = await startServer({
  port: 3030,
  quiet: true,
  piAgentDirectory: null,
  databasePath: join(dataDirectory, "protocol-e2e.db"),
});
process.stdout.write(`E2E_SERVER_READY ${JSON.stringify(result)}\n`);
