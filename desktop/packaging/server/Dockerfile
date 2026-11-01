# NalamDesk Server image. Build from the desktop/ folder:
#   docker build -f packaging/server/Dockerfile -t nalamdesk-server .
# See docs/self-hosting.md for running it.

# Build and runtime use the same Node major, so the native modules
# (SQLCipher, argon2) built here load in the runtime image.
ARG NODE_IMAGE=node:22-bookworm

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Electron and electron-builder install hooks are not needed for the server.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ARG NALAMDESK_BUILD_COMMIT
ARG NALAMDESK_RELAY_URL
ARG NALAMDESK_BOOKING_API_URL
RUN npm run build:server \
    && npm run build:web \
    && node scripts/package-server.js stage --out /out

FROM ${NODE_IMAGE}-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="NalamDesk Server" \
      org.opencontainers.image.description="Self-hosted NalamDesk clinic server" \
      org.opencontainers.image.source="https://github.com/nalamdesk/nalamdesk" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"

RUN groupadd --system --gid 10001 nalamdesk \
    && useradd --system --uid 10001 --gid nalamdesk --home-dir /var/lib/nalamdesk --shell /usr/sbin/nologin nalamdesk \
    && install -d -o nalamdesk -g nalamdesk -m 0700 /var/lib/nalamdesk

COPY --from=build /out/nalamdesk-server /opt/nalamdesk-server
RUN ln -s /opt/nalamdesk-server/bin/nalamdesk-server /usr/local/bin/nalamdesk-server

ENV NALAMDESK_DATA_DIR=/var/lib/nalamdesk \
    NALAMDESK_HOST=0.0.0.0 \
    NALAMDESK_PORT=3000
# The vault, key file, backups and TLS files. Mount a volume here.
VOLUME ["/var/lib/nalamdesk"]
EXPOSE 3000
USER nalamdesk
WORKDIR /opt/nalamdesk-server/app

# A TCP check, so it works with HTTPS, a self-signed certificate or plain HTTP behind a proxy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "require('net').connect(Number(process.env.NALAMDESK_PORT)||3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]

ENTRYPOINT ["node", "/opt/nalamdesk-server/app/dist/server/server/headless/main.js"]
CMD ["start"]
