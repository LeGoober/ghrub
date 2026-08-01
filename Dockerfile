# ghrub — multi-stage build, node:20-alpine (small image for Render Docker)
#
# M1: better-sqlite3 is a native addon, so the deps stage installs alpine build
# tools (python3 make g++) before `npm ci` compiles it.

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++   # M1: build tools for the better-sqlite3 native addon
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docs/seed/grocery-history.json ./docs/seed/grocery-history.json

# Render provides PORT; default 3000 for local docker run.
ENV PORT=3000
EXPOSE 3000

# Render mounts the persistent disk at /data (see render.yaml). SQLite DB lives there.
# The healthcheck hits /healthz (no DB dependency).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:${PORT}/healthz || exit 1

CMD ["node", "src/server.js"]
