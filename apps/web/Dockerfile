# syntax=docker/dockerfile:1
# StraforAI web image — build context MUST be the repo root:
#   docker build -f apps/web/Dockerfile .
# Multi-stage: pnpm install → next build (standalone output) → slim runner.

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching. Every workspace project's
# package.json is copied so pnpm can load the full workspace graph and honor
# --frozen-lockfile (missing importer dirs would break the lockfile check).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# Workspace devDep manifests — needed so pnpm can resolve workspace:* .
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/node-common/package.json packages/node-common/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter @strafor/web --frozen-lockfile \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
# Root manifests pin corepack to the repo's pnpm (packageManager field) and
# let pnpm load the workspace — without them it downloads the latest pnpm,
# which re-resolves workspace:* deps and fails.
COPY pnpm-workspace.yaml package.json ./
COPY apps/web ./apps/web
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
# next.config.ts sets outputFileTracingRoot to the repo root, so standalone
# output at apps/web/.next/standalone includes the traced node_modules tree.
RUN cd apps/web && pnpm build

FROM node:22-alpine AS runner
RUN apk add --no-cache dumb-init wget
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3010 \
    HOSTNAME=0.0.0.0

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3010/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
# With outputFileTracingRoot at the repo root the server entrypoint lives at
# standalone/apps/web/server.js.
CMD ["node", "apps/web/server.js"]
