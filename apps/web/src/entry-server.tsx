import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { router } from "./router";

export default createStartHandler({ createRouter: () => router })(defaultStreamHandler);
