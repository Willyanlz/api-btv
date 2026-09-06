FROM tailscale/tailscale:stable AS tailscale

FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends adb aapt ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /home/node/.android \
    && chown -R node:node /data /home/node/.android

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
