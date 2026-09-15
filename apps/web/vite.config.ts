import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.GLASSBOX_SERVER_ORIGIN ?? "http://127.0.0.1:3030",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/ws": {
        target: process.env.GLASSBOX_SERVER_ORIGIN ?? "http://127.0.0.1:3030",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
