# Build stages match the runtime's Debian release (trixie = debian13) so the
# glibc the native modules link against is the one distroless ships.
FROM node:24-trixie-slim AS web-build
RUN npm install -g pnpm@11
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter '@todou/web...'
RUN pnpm --filter @todou/web build

FROM node:24-trixie-slim AS server-deps
RUN npm install -g pnpm@11
WORKDIR /app
COPY . .
RUN CI=true pnpm install --prod --frozen-lockfile --filter '@todou/server...'
# The runtime image has no shell, so /data ownership can only arrive via COPY
# from a stage that could chown it (distroless nonroot = uid 65532).
RUN mkdir -p /data && chown 65532:65532 /data

FROM gcr.io/distroless/nodejs24-debian13:nonroot
COPY --from=server-deps --chown=65532:65532 /data /data
COPY --from=server-deps /app /app
COPY --from=web-build /app/projects/web/dist /app/projects/web/dist
ENV NODE_ENV=production \
    TODOU_DATABASE_SYSTEM=pglite:///data/system \
    TODOU_STORAGE_PATH=/data/attachments \
    TODOU_HTTP_STATIC_DIR=/app/projects/web/dist
# WORKDIR /data keeps relative database/storage paths — and the optional
# ./todou.toml — inside the volume; env vars still win over the file.
WORKDIR /data
VOLUME /data
EXPOSE 8637
# The image entrypoint is node itself; `serve` is also the default command,
# spelled out so `docker run <image> /app/... migrate` reads as the override.
CMD ["/app/projects/server/src/index.ts", "serve"]
