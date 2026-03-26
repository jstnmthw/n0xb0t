FROM node:24-alpine

WORKDIR /app

# Install build tools for native addons (better-sqlite3) and pnpm
RUN apk add --no-cache python3 make g++
RUN corepack enable

# Install dependencies (including native better-sqlite3 for Alpine)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source (plugins/config/data come from volume mounts)
COPY tsconfig.json ./
COPY src/ ./src/

CMD ["pnpm", "start"]
