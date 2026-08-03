# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-alpine AS dependencies
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM dependencies AS build

ENV NODE_ENV=production

COPY index.html tokens.css tsconfig.json vite.config.ts ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CONFIG_PATH=/app/config/dashboard.config.ts \
    DASHBOARD_DB=/app/data/dashboard.db \
    LOG_LEVEL=info \
    LOG_FORMAT=json

COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun config ./config
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/dashboard-entrypoint

RUN mkdir -p /app/data && chown bun:bun /app/data

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health'); if (!r.ok) process.exit(1)"]

ENTRYPOINT ["dashboard-entrypoint"]
CMD ["bun", "dist/server/main.js"]
