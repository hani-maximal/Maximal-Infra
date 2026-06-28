# ── deps: install all dependencies ─────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── builder: compile Next.js and Fastify ───────────────────────────────────
FROM deps AS builder
COPY . .
RUN pnpm exec next build
RUN pnpm exec tsc -p tsconfig.server.json

# ── runner: minimal production image ───────────────────────────────────────
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

# Production dependencies for Fastify.
# Next.js standalone bundles its own node_modules subset separately.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# Fastify server bundle
COPY --from=builder /app/dist/src ./dist/src

# Next.js standalone server + static assets + public dir
COPY --from=builder /app/.next/standalone ./nextjs
COPY --from=builder /app/.next/static ./nextjs/.next/static
COPY --from=builder /app/public ./nextjs/public

# Contracts consumed by Fastify at runtime
COPY contracts ./contracts

COPY start.sh ./start.sh
RUN chmod +x start.sh && chown -R node:node /app

USER node

# 4310 = Fastify engine  |  3000 = Next.js frontend
EXPOSE 4310 3000

CMD ["./start.sh"]
