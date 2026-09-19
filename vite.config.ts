import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "./apps/web",
  lint: {
    ignorePatterns: ["dist/**", "upstream/**", ".agy-staff/**", "apps/web/e2e/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["apps/server/src/**/*.test.ts", "apps/web/src/management/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/upstream/**", "apps/web/e2e/**", "**/.agy-staff/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
