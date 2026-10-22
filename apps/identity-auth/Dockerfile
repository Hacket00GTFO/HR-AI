# syntax=docker/dockerfile:1
# identity-auth image — build context MUST be the repo root:
#   docker build -f apps/identity-auth/Dockerfile .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/identity-auth/package.json apps/identity-auth/package.json
COPY packages/node-common/package.json packages/node-common/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
# Cache mount keeps the pnpm store across failed layers — on a flaky network a
# retry resumes downloads instead of starting from zero.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter @strafor/identity-auth --frozen-lockfile \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

COPY packages/node-common packages/node-common
COPY packages/tsconfig packages/tsconfig
COPY packages/eslint-config packages/eslint-config
COPY apps/identity-auth apps/identity-auth
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @strafor/identity-auth build \
    && pnpm deploy --filter @strafor/identity-auth --prod --legacy /deploy \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

FROM node:22-alpine AS runner
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

# `pnpm deploy` flattens to the package root; dist/ is the compiled app.
COPY --from=build /deploy ./

RUN mkdir -p /app/keys && chown -R node:node /app
USER node

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD wget -qO- http://localhost:3001/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
# Migrate (scripts/migrate.js, shipped in the deploy bundle) then serve.
CMD ["sh", "docker-entrypoint.sh"]
