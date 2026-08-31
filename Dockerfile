# ── Stage 1: Build the SPA ─────────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Compile the backend and prune to production deps ──────────────────
# Debian rather than Alpine: better-sqlite3 and argon2 are native addons, and they have to
# be built against the same libc the production stage runs on.
FROM node:22-bookworm-slim AS backend-builder
WORKDIR /app
# python3/make/g++ are needed to compile the native addons from source when no prebuilt
# binary matches this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ── Stage 3: Production image ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS production
WORKDIR /app

# The publish workflow adds source, version and revision labels per build; the ones here are
# fixed for the image.
LABEL org.opencontainers.image.title="msOauth2api" \
      org.opencontainers.image.description="Microsoft OAuth2 mailboxes as HTTP endpoints, with a Vue admin panel" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production

# V8 sizes its default heap from the memory it can see, which is generous, and only collects
# hard as it approaches that ceiling. On a small host the heap alone can grow past what is
# left after SQLite and an IMAP fetch, and the OOM killer arrives first. Capping it makes GC
# start early enough to matter. Override the whole variable on a larger host.
ENV NODE_OPTIONS="--max-old-space-size=512"

# gosu lets the entrypoint fix data-dir ownership as root and then drop to the non-root
# `node` user. ca-certificates is required to verify TLS to Microsoft's endpoints.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates gosu \
 && rm -rf /var/lib/apt/lists/*

COPY --from=backend-builder /app/node_modules  ./node_modules
COPY --from=backend-builder /app/dist          ./dist
COPY --from=backend-builder /app/package.json  ./package.json
# The server serves the SPA from ../public relative to dist/, same-origin with the API.
COPY --from=frontend-builder /frontend/dist    ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
# Prefer IPv4: container networks routinely advertise IPv6 that does not route, which
# otherwise shows up as slow or failing calls to login.microsoftonline.com.
CMD ["node", "--dns-result-order=ipv4first", "dist/server.js"]
