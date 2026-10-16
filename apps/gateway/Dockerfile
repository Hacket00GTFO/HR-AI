# syntax=docker/dockerfile:1
# gateway image — build context MUST be the repo root:
#   docker build -f apps/gateway/Dockerfile .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/node-common/package.json packages/node-common/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter @strafor/gateway --frozen-lockfile \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

COPY packages/node-common packages/node-common
COPY packages/tsconfig packages/tsconfig
COPY packages/eslint-config packages/eslint-config
COPY apps/gateway apps/gateway
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @strafor/gateway build \
    && pnpm deploy --filter @strafor/gateway --prod --legacy /deploy \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

FROM node:22-alpine AS runner
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /deploy ./
RUN chown -R node:node /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
