import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/manage": {
        target: "http://localhost:3030",
        changeOrigin: true,
        bypass: (req) => {
          if (req.headers.accept?.includes("text/html")) {
            return "/index.html";
          }
        },
      },
      "/api": {
        target: "http://localhost:3030",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/ws": {
        target: "http://localhost:3030",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
