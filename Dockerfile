# ─────────────────────────────────────────────────────────────
# Stage 1 — Backend dependencies
#   Production-only, cached separately from source for fast rebuilds.
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ─────────────────────────────────────────────────────────────
# Stage 2 — Build the React admin/chat frontend (webui/dist)
#   The dev tooling (vite, tailwind, postcss) lives only in this
#   stage; nothing leaks into the final image.
#
#   webui/vite.config.js reads ../package.json at build time to
#   inject __APP_VERSION__, so the root package.json must be
#   present in this stage too.
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS webui-builder
WORKDIR /app

# Root package.json is required by webui/vite.config.js for the
# version-inject define hook.
COPY package.json ./

WORKDIR /app/webui
COPY webui/package.json webui/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY webui/ ./
RUN npm run build

# ─────────────────────────────────────────────────────────────
# Stage 3 — Runtime image
#   Slim Alpine with only what's needed to `node src/start.js`.
#   Includes the prebuilt webui/dist so the admin panel is served
#   out of the box (the panel is required to use the v1.1.2 PR
#   features: API-key management, per-account proxy mode, on-demand
#   proxy test, usage stats).
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Backend node_modules + source
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY api ./api

# Prebuilt frontend bundle — server.js mounts this as static when present
COPY --from=webui-builder /app/webui/dist ./webui/dist

# Persistent dirs (data.json + log files when DATA_SAVE_MODE=file /
# ENABLE_FILE_LOG=true). Mount these as volumes in compose.
RUN mkdir -p /app/data /app/logs

EXPOSE 3000

CMD ["node", "src/start.js"]
