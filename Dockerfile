FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY ui ./ui
COPY public/favicon.svg ./public/favicon.svg
COPY src ./src
RUN pnpm exec vite build && pnpm exec tsc -p tsconfig.server.json

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY --from=build /app/public ./public
COPY --from=build /app/dist/src ./dist/src
COPY contracts ./contracts

USER node
EXPOSE 4310

CMD ["node", "dist/src/server.js"]
