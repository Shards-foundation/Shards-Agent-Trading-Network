# syntax=docker/dockerfile:1.7
# Staging backend image: the API and durable worker are separate processes.
# No private keys or deployment environment files are baked into this image.
FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.15.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile
# Prisma generation validates the schema locally; this is NOT a connection
# string for a real database and no migration is run during image build.
RUN DATABASE_URL=postgresql://satn:fixture@127.0.0.1:5432/satn pnpm db:generate \
    && pnpm --filter @satn/api build \
    && test -s apps/api/dist/index.js \
    && test -s apps/api/dist/worker-main.js \
    && node --check apps/api/dist/index.js \
    && node --check apps/api/dist/worker-main.js

FROM node:22-bookworm-slim AS runtime
WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.15.1 --activate
ENV NODE_ENV=production
# Install the pnpm package-manager cache at a path readable by the\n# unprivileged runtime user (the migration command must work offline).\nENV COREPACK_HOME=/opt/corepack\nRUN mkdir -p /opt/corepack \\\n    && corepack enable \\\n    && corepack prepare pnpm@10.15.1 --activate \\\n    && chown -R node:node /opt/corepack\n# Keep workspace packages and Prisma CLI for the explicit one-shot migration
# job. This deliberately favours correctness over minimal image size in staging.
COPY --from=build --chown=node:node /workspace /workspace
USER node
CMD ["node", "apps/api/dist/index.js"]
