FROM oven/bun:1.4.2 AS build
WORKDIR /source
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts \
    && bun run --filter='@stanley2058/lilac-computer-use-gateway' build

FROM docker:29-cli AS docker-cli
FROM oven/bun:1.4.2
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /source/apps/computer-use-gateway/dist/main.js /opt/lilac/gateway.js
COPY packages/computer-use-runner/seccomp-chromium.json /opt/lilac/seccomp-chromium.json
RUN mkdir -p /data && chmod 700 /data
EXPOSE 8080
CMD ["bun", "/opt/lilac/gateway.js"]
