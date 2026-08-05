FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN useradd --create-home --uid 10001 xuanshu
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps --ignore-scripts \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
RUN mkdir -p /data/runs /workspace/input /workspace/work /run/xuanshu \
    && chown -R xuanshu:xuanshu /data /workspace/work /run/xuanshu

USER xuanshu
ENV NODE_ENV=production
EXPOSE 7318
CMD ["node", "dist/cli.js", "serve", "--config", "config/container.yaml"]
