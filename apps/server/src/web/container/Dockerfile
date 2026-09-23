FROM node:24-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
WORKDIR /app

COPY apps/server/src/web/container/package*.json ./
RUN npm ci --no-audit --no-fund
RUN npx playwright install --with-deps chromium

COPY apps/server/src/web/network-guard.ts ./network-guard.ts
COPY apps/server/src/web/browser-proxy.ts ./browser-proxy.ts
COPY apps/server/src/web/container/proxy-entrypoint.ts ./container/proxy-entrypoint.ts
COPY apps/server/src/web/container/cli-entrypoint.mjs ./cli-entrypoint.mjs
RUN npx esbuild container/proxy-entrypoint.ts --bundle --platform=node --format=esm --packages=bundle --outfile=proxy-entrypoint.mjs

USER node
CMD ["sleep", "infinity"]
