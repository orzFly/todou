# Build stages match the runtime's Debian release (trixie = debian13) so the
# glibc the native modules link against is the one distroless ships.
FROM node:24-trixie-slim AS web-build
RUN npm install -g pnpm@11
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter '@todou/web...'
# The context excludes .git (.dockerignore), so the version arrives as a build
# arg: docker.yaml passes `git describe --tags --always --dirty`; a local
# build may pass the same or accept "unknown" in the footer. Declared after
# the install so version churn never busts that layer's cache. ARG doubles as
# the env var vite reads.
ARG TODOU_BUILD_VERSION=""
RUN pnpm --filter @todou/web build

FROM node:24-trixie-slim AS server-deps
RUN npm install -g pnpm@11
WORKDIR /app
COPY . .
RUN CI=true pnpm install --prod --frozen-lockfile --filter '@todou/server...'
# Same injection scripts/build-cli.sh uses — overwrite the tracked
# placeholder — so `todou-server --version` and /api/version answer without
# git, which the distroless runtime does not carry.
ARG TODOU_BUILD_VERSION=""
RUN [ -z "$TODOU_BUILD_VERSION" ] || printf \
    'export const BUILD_VERSION: string | null = "%s";\n' \
    "$TODOU_BUILD_VERSION" > projects/shared/src/build-info.ts
# The runtime image has no shell, so /data ownership can only arrive via COPY
# from a stage that could chown it (distroless nonroot = uid 65532).
RUN mkdir -p /data && chown 65532:65532 /data

# The CLI builds the image hands out over /api/cli (T-146). Both arch runners
# build the whole set — the artifacts a deployment serves have nothing to do
# with the platform it runs on, and a deployment that could only serve its own
# platform would be useless to everyone else's laptop.
FROM node:24-trixie-slim AS cli-build
RUN npm install -g pnpm@11
# deno publishes a multi-arch bin image, so this resolves to the builder's own
# platform; the four compile targets are cross-built from there.
COPY --from=docker.io/denoland/deno:bin-2.8.3 /deno /usr/local/bin/deno
RUN apt-get update \
 && apt-get install -y --no-install-recommends zstd ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# Dev dependencies included, unlike server-deps: build-cli.sh bundles
# todou.cjs with the root esbuild. The prod-only tree `deno compile` needs is
# staged separately by the script, so no dev package reaches an artifact.
RUN CI=true pnpm install --frozen-lockfile --filter '@todou/cli...'
# Read by build-cli.sh, which injects it into build-info.ts in its own staged
# copy — same mechanism, same file as the server stage's printf above.
ARG TODOU_BUILD_VERSION=""
# `copy` staging because the context carries no .git to list; .dockerignore
# has already made it equivalent to the tracked tree.
RUN scripts/build-cli.sh --stage-mode copy \
 && scripts/pack-cli.sh dist /cli-dist

FROM gcr.io/distroless/nodejs24-debian13:nonroot
COPY --from=server-deps --chown=65532:65532 /data /data
COPY --from=server-deps /app /app
COPY --from=web-build /app/projects/web/dist /app/projects/web/dist
COPY --from=cli-build /cli-dist /app/cli-dist
# There is no shell to interpret a wrapper, but the kernel execs shebang
# interpreters directly, so an absolute-path shebang gives the image a real
# `todou-server` command. argv stays [node, wrapper, ...args] — the same
# shape `node src/index.ts` produces, which runExit's argv.slice(2) expects.
COPY --chmod=755 <<'EOF' /usr/local/bin/todou-server
#!/nodejs/bin/node
import("/app/projects/server/src/index.ts");
EOF
ENV NODE_ENV=production \
    TODOU_DATABASE_SYSTEM=pglite:///data/system \
    TODOU_STORAGE_PATH=/data/attachments \
    TODOU_HTTP_STATIC_DIR=/app/projects/web/dist \
    TODOU_HTTP_CLI_DIST_DIR=/app/cli-dist
# WORKDIR /data keeps relative database/storage paths — and the optional
# ./todou.toml — inside the volume; env vars still win over the file.
WORKDIR /data
VOLUME /data
EXPOSE 8637
# Clear the base image's `node` entrypoint so CMD[0] is PATH-resolved: both
# `docker run <image>` and `docker run <image> todou-server migrate` work.
ENTRYPOINT []
CMD ["todou-server", "serve"]
