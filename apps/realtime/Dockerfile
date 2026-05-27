# Build stage
FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable

# Copy workspace metadata so pnpm can hydrate the dep graph correctly
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY apps/realtime/package.json apps/realtime/tsconfig.json apps/realtime/

# Install all deps with frozen lockfile in CI; without it locally
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --filter @vtm/realtime... --filter @vtm/shared

# Copy source and build
COPY packages/shared/src packages/shared/src
COPY apps/realtime/src apps/realtime/src
RUN pnpm --filter @vtm/realtime build

# Runtime stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini && corepack enable

COPY --from=builder /repo/pnpm-workspace.yaml /repo/package.json ./
COPY --from=builder /repo/packages/shared ./packages/shared
COPY --from=builder /repo/apps/realtime/package.json ./apps/realtime/
COPY --from=builder /repo/apps/realtime/dist ./apps/realtime/dist
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/realtime/node_modules ./apps/realtime/node_modules

EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/realtime/dist/server.js"]
