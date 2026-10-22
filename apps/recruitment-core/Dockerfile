# syntax=docker/dockerfile:1
# recruitment-core image — build context MUST be the repo root:
#   docker build -f apps/recruitment-core/Dockerfile .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/recruitment-core/package.json apps/recruitment-core/package.json
# Workspace dep manifests — needed so pnpm resolves workspace:*
COPY packages/node-common/package.json packages/node-common/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter @strafor/recruitment-core --frozen-lockfile \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

COPY packages/node-common packages/node-common
COPY packages/contracts packages/contracts
COPY packages/tsconfig packages/tsconfig
COPY packages/eslint-config packages/eslint-config
COPY apps/recruitment-core apps/recruitment-core

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @strafor/recruitment-core build
# Standalone prod bundle (package files + prod node_modules) in /deploy.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @strafor/recruitment-core --prod --legacy /deploy \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

FROM node:22-alpine AS runner
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /deploy ./
USER node

EXPOSE 3009
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3009/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
# server.js runs `node-pg-migrate up` (migrations/) during boot.
CMD ["node", "dist/server.js"]
