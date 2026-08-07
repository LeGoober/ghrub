# ghrub — multi-stage build on node:20-slim.
#
# The Neon migration replaced better-sqlite3 with `pg`, which is pure
# JavaScript. That removes the whole reason this image used to install
# python3/make/g++ and the reason it had to stay on glibc: there is no native
# addon left to compile, and nothing that can segfault on musl at runtime.
# Kept on slim rather than moved to alpine because the difference is now small
# and slim is the better-tested base.

# ---- deps ----
FROM node:20-slim AS deps
WORKDIR /app
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

# State lives in Neon (DATABASE_URL), so this image is entirely stateless — no
# volume, no disk, safe to replace at any time.
# Healthcheck uses Node's global fetch (slim has no wget/curl) and hits /healthz.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
