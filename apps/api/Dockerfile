# syntax=docker/dockerfile:1
# StraforAI API image — build context MUST be the repo root:
#   docker build -f apps/api/Dockerfile .
# Uses `pnpm deploy` to produce a self-contained prod install of @strafor/api.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
# Workspace devDep manifests — needed so pnpm can resolve workspace:*
# during install/deploy (they are not shipped in the final image).
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/node-common/package.json packages/node-common/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter @strafor/api --frozen-lockfile \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

COPY apps/api apps/api
COPY packages/eslint-config packages/eslint-config
COPY packages/node-common packages/node-common
COPY packages/contracts packages/contracts
# Standalone prod bundle (package files + prod node_modules) in /deploy.
# --legacy: pnpm >=10 requires it for workspaces without inject-workspace-packages.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @strafor/api --prod --legacy /deploy \
        --config.minimumReleaseAge=0 --config.minimumReleaseAgeStrict=false

FROM node:22-alpine AS runner
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /deploy ./

# Runtime resume storage is mounted here (compose: resumes-data volume);
# server.js resolves it via RESUMES_DIR.
RUN mkdir -p /app/secure_uploads/resumes /app/secure_uploads/exports && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
# server.js runs `node-pg-migrate up` (apps/api/migrations) during boot —
# a fresh `docker compose up` gets a fully migrated schema automatically.
CMD ["node", "server.js"]
