# syntax=docker/dockerfile:1.7
# Prism Studio — single-service image for Railway (or any Docker host).
#
#   docker build -t prism-studio .
#   docker build -t prism-studio --build-arg WITH_SEGMENTATION=1 .   # bake AI cutouts in
#
# Runtime contract: PORT (set by Railway), PRISM_PUBLIC_URL, PRISM_SIGNUP_CODE,
# persistent volume at /data. No Codex credentials are baked in; each user signs
# in to their own Codex account from inside the app (device-code login).

ARG NODE_IMAGE=node:22-bookworm-slim
ARG WITH_SEGMENTATION=0

# ---------------------------------------------------------------------------
# 1. Build the React client and produce production-only node_modules.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# 2. Optional: Python 3.12 runtime + BiRefNet model baked into the image.
#    Always runs, but is a no-op (empty dirs) unless WITH_SEGMENTATION=1.
#    Installed to /opt so the model ships in the image, not on the volume.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS segmentation
ARG WITH_SEGMENTATION
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python/versions \
    PATH=/opt/python/current/bin:$PATH
COPY package.json ./
COPY assets ./assets
COPY server ./server
COPY scripts ./scripts
RUN mkdir -p /opt/python /opt/prism-segmentation \
 && if [ "$WITH_SEGMENTATION" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
      && uv python install 3.12 \
      && ln -s "$(dirname "$(dirname "$(uv python find 3.12)")")" /opt/python/current \
      && PRISM_DATA_DIR=/opt/prism-segmentation node scripts/setup-segmentation.mjs \
      && chmod -R a+rX /opt/python /opt/prism-segmentation; \
    else echo "Skipping segmentation (WITH_SEGMENTATION=$WITH_SEGMENTATION)"; fi

# ---------------------------------------------------------------------------
# 3. Runtime image.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG WITH_SEGMENTATION
ARG CODEX_VERSION=latest

# ca-certificates: Codex CLI HTTPS. fontconfig + fonts: server-side text layers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-dejavu-core fonts-liberation tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@openai/codex@${CODEX_VERSION}" --no-audit --no-fund \
 && npm cache clean --force \
 && codex --version

WORKDIR /app
COPY --from=build --chown=root:root /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/server ./server
COPY --from=build --chown=root:root /app/shared ./shared
COPY --from=build --chown=root:root /app/assets ./assets
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/scripts ./scripts
COPY --from=segmentation /opt/python /opt/python
COPY --from=segmentation /opt/prism-segmentation /opt/prism-segmentation

# Persistent data (accounts, documents, per-user Codex tokens) lives on /data.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data

ENV NODE_ENV=production \
    PRISM_HOSTED=1 \
    PRISM_DATA_ROOT=/data \
    PRISM_SEGMENTATION=${WITH_SEGMENTATION} \
    PRISM_SEGMENTATION_DIR=/opt/prism-segmentation \
    PRISM_CODEX_BIN=codex \
    PORT=8080 \
    HOME=/home/node \
    PATH=/opt/python/current/bin:$PATH

# No VOLUME instruction: Railway rejects it and attaches volumes itself. Railway
# mounts volumes owned by root, so set RAILWAY_RUN_UID=0 there (see README).
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>r.json()).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
