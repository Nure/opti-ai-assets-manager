FROM node:20-bullseye-slim

WORKDIR /app/server
ENV NODE_ENV=production

# Copy only package.json first so Docker can cache dependency installation.
# We intentionally use npm install instead of npm ci because this starter project
# should not be tied to a generated lockfile from another machine/registry.
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && node -e "import('express').then(() => console.log('express dependency verified'))"

COPY server ./
RUN mkdir -p /app/data/downloads /app/data/uploads /app/data/exports /app/data/tmp

WORKDIR /app
EXPOSE 8080
CMD ["node", "/app/server/src/index.js"]
