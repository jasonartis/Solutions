# Worker image — build from the MONOREPO ROOT:
#   docker build -f apps/worker/Dockerfile -t solutions-worker .
#
# Base = Playwright's official image: Chromium + all OS deps preinstalled,
# published for amd64 AND arm64, so the same Dockerfile works on a Hetzner
# (x86) or Oracle (ARM) VPS. The tag MUST match the playwright version in
# apps/worker/package.json — bump both together.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

WORKDIR /repo

# corepack pins pnpm to the version in package.json's packageManager field.
RUN corepack enable

# Install with the same hoisted layout we use locally (.npmrc), then build.
# The worker imports module sources by relative path, so the whole workspace
# is the build context (kept small by .dockerignore).
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter worker build

ENV NODE_ENV=production
EXPOSE 8901

# Config comes from the environment (docker compose env_file) — there is no
# .env baked into the image, and the service-role key must never be.
CMD ["node", "apps/worker/dist/apps/worker/src/index.js"]
