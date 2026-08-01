# ghrub — multi-stage build, node:20-alpine (small image for Render Docker)
#
# M0: no native modules, so this is minimal.
# M1 NOTE: better-sqlite3 is a native addon. When you add it, the `deps` stage
# needs build tools on alpine — uncomment the apk line below:
#     RUN apk add --no-cache python3 make g++
# (or switch the base to node:20-slim which ships more build tooling).

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
# RUN apk add --no-cache python3 make g++   # <- uncomment in M1 for better-sqlite3
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
# COPY docs/seed ./docs/seed        # <- uncomment in M1 so `npm run seed` has data

# Render provides PORT; default 3000 for local docker run.
ENV PORT=3000
EXPOSE 3000

# Render mounts the persistent disk at /data (see render.yaml). SQLite DB lives there.
# The healthcheck hits /healthz (no DB dependency).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:${PORT}/healthz || exit 1

CMD ["node", "src/server.js"]
