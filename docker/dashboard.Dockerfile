# repo-ai dashboard UI (#291): the TanStack Start app, no repo-ai CLI inside.
# Build from the repo root:  docker build -f docker/dashboard.Dockerfile .

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/package.json
# Only the dashboard's dependency closure; the docs workspace is not installed.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @infrazero/repo-ai-dashboard...
# The CLI's src/ is type-only for the app and erased at build time, so it is not copied.
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @infrazero/repo-ai-dashboard build

# ── runtime: Nitro's self-contained server output ────────────────────────────
FROM node:24-slim
WORKDIR /app
COPY --from=build --chown=node:node /src/apps/dashboard/.output ./.output
USER node
ENV PORT=3000 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 3000
# The app refuses non-loopback Host headers, so probe with Host: localhost.
HEALTHCHECK --interval=10s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/',{headers:{host:'localhost'}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]
