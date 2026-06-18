# ─────────────────────────────────────────────────────────────
# Stage 1 — Backend dependencies
#   Production-only, cached separately from source for fast rebuilds.
#   Uses Debian slim (same as runtime) for native module compatibility.
# ─────────────────────────────────────────────────────────────
FROM node:20-slim AS deps
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
#   Debian slim with Playwright Chromium for browser-based login
#   (bypasses Aliyun WAF/captcha). Serves the prebuilt webui/dist
#   admin panel out of the box.
#
#   Why not Alpine? Playwright/Chromium requires glibc; Alpine
#   uses musl which is incompatible with the prebuilt binaries.
# ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# Playwright needs this to find browsers in the expected location
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

# Install system dependencies required by Playwright Chromium
# (fonts, graphics libs, dbus, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    wget \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Backend node_modules + source
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY api ./api

# Install Playwright Chromium browser binary
# This step uses the playwright version from node_modules
RUN npx playwright install chromium

# Prebuilt frontend bundle — server.js mounts this as static when present
COPY --from=webui-builder /app/webui/dist ./webui/dist

# Persistent dirs (data.json + log files when DATA_SAVE_MODE=file /
# ENABLE_FILE_LOG=true). Mount these as volumes in compose.
RUN mkdir -p /app/data /app/logs

EXPOSE 3000

CMD ["node", "src/start.js"]
