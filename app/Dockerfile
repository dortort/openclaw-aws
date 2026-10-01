# syntax=docker/dockerfile:1
ARG OPENCLAW_IMAGE_TAG
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_IMAGE_TAG}

ARG OPENCLAW_VERSION=""
LABEL org.opencontainers.image.source="https://github.com/dortort/openclaw-aws"
LABEL org.opencontainers.image.version="${OPENCLAW_VERSION}"

USER root

RUN install -d -o node -g node /state

COPY config/ /app/config/
COPY --chmod=0755 entrypoint.sh /app/entrypoint.sh

ENV HOME=/state

USER node

EXPOSE 18789
ENTRYPOINT ["tini", "-s", "--", "/app/entrypoint.sh"]
CMD []
