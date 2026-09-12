FROM oven/bun:1.4.2 AS build
WORKDIR /source
COPY package.json bun.lock ./
COPY apps/computer-use-gateway/package.json apps/computer-use-gateway/package.json
COPY patches patches
RUN bun install --frozen-lockfile --ignore-scripts \
    --filter='@stanley2058/lilac-computer-use-gateway'
COPY tsconfig.json ./
COPY apps/computer-use-gateway/tsconfig.json apps/computer-use-gateway/
COPY apps/computer-use-gateway/src apps/computer-use-gateway/src
RUN bun run --filter='@stanley2058/lilac-computer-use-gateway' build

FROM docker:29-cli AS docker-cli
FROM oven/bun:1.4.2
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /source/apps/computer-use-gateway/dist/main.js /opt/lilac/gateway.js
COPY packages/computer-use-runner/seccomp-chromium.json /opt/lilac/seccomp-chromium.json
RUN mkdir -p /data && chmod 700 /data
EXPOSE 8080
CMD ["bun", "/opt/lilac/gateway.js"]
