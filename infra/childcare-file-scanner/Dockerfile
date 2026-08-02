FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ARG CARECONNEX_GIT_SHA
ARG CARECONNEX_LOCK_SHA256
LABEL org.opencontainers.image.revision="${CARECONNEX_GIT_SHA}" \
      careconnex.dependency-lock-sha256="${CARECONNEX_LOCK_SHA256}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends clamav clamav-daemon ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY entrypoint.sh /usr/local/bin/childcare-scanner-entrypoint
RUN chmod 0555 /usr/local/bin/childcare-scanner-entrypoint \
    && chown -R node:node /app

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/childcare-scanner-entrypoint"]
