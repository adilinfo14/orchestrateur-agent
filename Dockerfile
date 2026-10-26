# Serveur central Agent Command Center (API + interface web).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/collector/package.json apps/collector/
RUN npm ci -w @acc/web -w @acc/server -w @acc/protocol --include-workspace-root --no-audit --no-fund
COPY packages packages
COPY apps/web apps/web
RUN npm run build -w @acc/web

FROM node:24-slim
ENV NODE_ENV=production ACC_HOST=0.0.0.0 ACC_PORT=7820 ACC_DATA_DIR=/data NODE_NO_WARNINGS=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/collector/package.json apps/collector/
RUN npm ci -w @acc/server -w @acc/protocol --omit=dev --no-audit --no-fund && npm cache clean --force
COPY packages packages
COPY apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7820
CMD ["node", "apps/server/src/main.ts"]
