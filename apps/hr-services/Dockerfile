# syntax=docker/dockerfile:1
# hr-services image — build context MUST be the repo root:
#   docker build -f apps/hr-services/Dockerfile .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/hr-services/package.json apps/hr-services/package.json
# Workspace dep manifests — needed so pnpm resolves workspace:*
COPY packages/node-common/package.json packages/node-common/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter @strafor/hr-services --frozen-lockfile \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

COPY packages/node-common packages/node-common
COPY packages/tsconfig packages/tsconfig
COPY packages/eslint-config packages/eslint-config
COPY apps/hr-services apps/hr-services

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @strafor/hr-services build
# Standalone prod bundle (package files + prod node_modules) in /deploy.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @strafor/hr-services --prod --legacy /deploy \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

FROM node:22-alpine AS runner
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /deploy ./
USER node

EXPOSE 3014
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3014/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
# server.js runs `node-pg-migrate up` (migrations/) during boot.
CMD ["node", "dist/server.js"]
