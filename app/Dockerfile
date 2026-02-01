FROM node:22-bookworm AS build

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
ARG OPENCLAW_VERSION=""

RUN apt-get update && \
  apt-get install -y --no-install-recommends ca-certificates curl git && \
  if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES; \
  fi && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY openclaw/package.json openclaw/pnpm-lock.yaml openclaw/pnpm-workspace.yaml openclaw/.npmrc ./
COPY openclaw/ui/package.json ./ui/package.json
COPY openclaw/patches ./patches
COPY openclaw/scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY openclaw/. .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

FROM node:22-bookworm-slim

ARG OPENCLAW_VERSION=""
LABEL org.opencontainers.image.source="https://github.com/openclaw/openclaw"
LABEL org.opencontainers.image.version="${OPENCLAW_VERSION}"

RUN apt-get update && \
  apt-get install -y --no-install-recommends ca-certificates && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/state

RUN mkdir -p /state && chown -R node:node /state

COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/openclaw.mjs /app/openclaw.mjs
COPY --from=build /app/assets /app/assets
COPY --from=build /app/extensions /app/extensions
COPY --from=build /app/skills /app/skills
COPY --from=build /app/patches /app/patches
COPY --from=build /app/docs /app/docs

COPY config/ /app/config/
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

USER node

EXPOSE 18789 18790
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD sh -lc 'if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"; else node dist/index.js health; fi'
ENTRYPOINT ["/app/entrypoint.sh"]
