# syntax=docker/dockerfile:1

# ---- build stage: install everything and compile TS -> dist/ ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime stage: production deps + compiled output + migrations ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# One image, two entrypoints. Compose overrides the command per service:
#   api    -> node dist/src/server.js
#   worker -> node dist/src/worker.js
# tsconfig rootDir='.' with src/scripts/test included emits under dist/src/.
# Both entrypoints run migrations on startup before doing work.
CMD ["node", "dist/src/server.js"]
