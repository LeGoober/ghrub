# ghrub — multi-stage build on node:20-slim (Debian/glibc).
#
# NOTE: base is node:20-slim, NOT alpine. better-sqlite3 is a native addon and
# segfaults (exit 139) at runtime on alpine/musl even when compiled there; slim
# (glibc) is the reliable base for better-sqlite3. Still a small image.
# The deps stage installs build tools (python3 make g++) so npm compiles the addon.

# ---- deps ----
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:20-slim AS runtime
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
# Healthcheck uses Node's global fetch (slim has no wget/curl) and hits /healthz.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
