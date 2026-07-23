ARG BASE_IMAGE=ubuntu:24.04
ARG NODE_MAJOR=22
ARG CONTAINER_UID=1000

############################
# Stage 1: runtime tools
############################
FROM ${BASE_IMAGE} AS tools
ARG NODE_MAJOR
ENV LILAC_USER=lilac
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  && rm -rf /var/lib/apt/lists/*

RUN install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && chmod a+r /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
  && ARCH="$(dpkg --print-architecture)" \
  && if [ "$ARCH" = "amd64" ]; then \
       curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
         | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
       chmod a+r /etc/apt/keyrings/google-chrome.gpg; \
       echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
         > /etc/apt/sources.list.d/google-chrome.list; \
     fi

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  build-essential \
  cmake \
  dnsutils \
  fd-find \
  ffmpeg \
  fonts-liberation \
  fonts-noto-color-emoji \
  git \
  gzip \
  imagemagick \
  iproute2 \
  iputils-ping \
  jq \
  libvulkan1 \
  mesa-vulkan-drivers \
  nodejs \
  openssh-client \
  pinentry-curses \
  python-is-python3 \
  python3 \
  python3-pip \
  python3-venv \
  ripgrep \
  sqlite3 \
  tar \
  tini \
  unzip \
  util-linux \
  vulkan-tools \
  && ARCH="$(dpkg --print-architecture)" \
  && if [ "$ARCH" = "amd64" ]; then \
       apt-get install -y --no-install-recommends google-chrome-stable; \
     fi \
  && rm -rf /var/lib/apt/lists/*

# Ubuntu/Debian call it "fdfind"
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

ARG CONTAINER_UID

# Create a dedicated regular user instead of inheriting an image account's
# groups or account settings. Ubuntu reserves UID/GID 1000 for `ubuntu`.
RUN case "$CONTAINER_UID" in \
      ''|*[!0-9]*) echo "CONTAINER_UID must be a numeric regular-user UID" >&2; exit 1 ;; \
    esac \
  && if [ "$CONTAINER_UID" -lt 1000 ] || [ "$CONTAINER_UID" -gt 60000 ]; then \
       echo "CONTAINER_UID must be between 1000 and 60000" >&2; exit 1; \
     fi \
  && if id -u "$LILAC_USER" >/dev/null 2>&1; then \
       userdel --remove "$LILAC_USER"; \
     fi \
  && existing_user="$(getent passwd "$CONTAINER_UID" | cut -d: -f1 || true)" \
  && if [ -n "$existing_user" ]; then \
       if [ "$existing_user" != "ubuntu" ]; then \
         echo "CONTAINER_UID is already assigned to a base-image account" >&2; exit 1; \
       fi; \
       userdel --remove ubuntu; \
     fi \
  && if getent group "$LILAC_USER" >/dev/null 2>&1; then \
       groupdel "$LILAC_USER"; \
     fi \
  && existing_group="$(getent group "$CONTAINER_UID" | cut -d: -f1 || true)" \
  && if [ -n "$existing_group" ]; then \
       if [ "$existing_group" != "ubuntu" ]; then \
         echo "CONTAINER_UID is already assigned to a base-image group" >&2; exit 1; \
       fi; \
       groupdel ubuntu; \
     fi \
  && groupadd --gid "$CONTAINER_UID" "$LILAC_USER" \
  && useradd --create-home --uid "$CONTAINER_UID" --gid "$LILAC_USER" \
       --shell /bin/bash "$LILAC_USER" \
  && [ "$(id -G "$LILAC_USER")" = "$CONTAINER_UID" ]
ENV HOME=/home/${LILAC_USER}
ENV DATA_DIR=/data
ENV LILAC_WORKSPACE_DIR=${DATA_DIR}/workspace
ENV GIT_CONFIG_GLOBAL=${DATA_DIR}/.gitconfig
ENV GNUPGHOME=${DATA_DIR}/secret/gnupg
ENV BUN_INSTALL_GLOBAL_DIR=${DATA_DIR}/.bun/install/global
ENV BUN_INSTALL_BIN=${DATA_DIR}/bin
ENV BUN_INSTALL_CACHE_DIR=${DATA_DIR}/.bun/install/cache
ENV NPM_CONFIG_PREFIX=${DATA_DIR}/.npm-global
ENV XDG_CONFIG_HOME=${DATA_DIR}/.config
ENV PATH=/usr/local/sbin:/usr/local/bin:${BUN_INSTALL_BIN}:${NPM_CONFIG_PREFIX}/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN mkdir -p $DATA_DIR $DATA_DIR/secret
RUN chown -R ${LILAC_USER}:$(id -gn "${LILAC_USER}") $DATA_DIR

USER ${LILAC_USER}

# uv (user-level)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
# bun (user-level), pinned to the workspace packageManager version.
COPY package.json /tmp/lilac-package.json
RUN BUN_VERSION="$(node -e 'const pm = require("/tmp/lilac-package.json").packageManager; const match = /^bun@(.+)$/.exec(pm ?? ""); if (!match) throw new Error(`packageManager must be bun@<version>, got ${pm}`); process.stdout.write(match[1]);')" \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
USER root
# Keep the runtime Bun executable in a stable, root-owned tools layer.
RUN install -o root -g root -m 0755 \
     /home/${LILAC_USER}/.bun/bin/bun \
     /usr/local/bin/bun

############################
# Stage 2: deps
############################

FROM tools AS deps
WORKDIR /app
# Copy only dependency manifests for layer caching
COPY package.json bun.lock ./
COPY apps/core/package.json apps/core/package.json
COPY apps/tool-bridge/package.json apps/tool-bridge/package.json
COPY apps/acp-controller/package.json apps/acp-controller/package.json
COPY apps/mini-lilac/package.json apps/mini-lilac/package.json
COPY apps/mini-lilac-server/package.json apps/mini-lilac-server/package.json
COPY apps/mini-lilac-tui/package.json apps/mini-lilac-tui/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/coding-tools/package.json packages/coding-tools/package.json
COPY packages/event-bus/package.json packages/event-bus/package.json
COPY packages/fs/package.json packages/fs/package.json
COPY packages/mini-lilac-client/package.json packages/mini-lilac-client/package.json
COPY packages/mini-lilac-runtime/package.json packages/mini-lilac-runtime/package.json
COPY packages/plugin-runtime/package.json packages/plugin-runtime/package.json
COPY packages/remote-fs-runner/package.json packages/remote-fs-runner/package.json
COPY packages/utils/package.json packages/utils/package.json
COPY patches patches

# Install only the main container's workspace graph. Other app sources remain
# available in /app, but their dependencies are not included in the image.
RUN bun install --frozen-lockfile \
      --filter '@stanley2058/lilac-tool-bridge' \
      --filter '@stanley2058/lilac-remote-fs-runner' \
  && find /app ! -type l -perm /022 -exec chmod go-w {} +

############################
# Stage 3: build + runtime entry
############################

FROM deps AS build
WORKDIR /app
COPY bunfig.toml tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

# Build client bundles
RUN (cd apps/tool-bridge && bun run build)
RUN (cd apps/core && bun run build:remote-runner)
RUN (cd packages/remote-fs-runner && bun run build)

# Keep the operator CLI outside the lilac-writable application build tree.
RUN install -d -o root -g root -m 0755 /usr/local/libexec/lilac-tool-bridge \
  && install -o root -g root -m 0755 \
       /app/apps/tool-bridge/dist/index.js \
       /usr/local/libexec/lilac-tool-bridge/index.js \
  && install -o root -g root -m 0644 \
       /app/apps/tool-bridge/dist/client.js \
       /usr/local/libexec/lilac-tool-bridge/client.js \
  && ln -s /usr/local/libexec/lilac-tool-bridge/index.js /usr/local/bin/tools

COPY --chmod=0755 docker/direct-entrypoint.sh /usr/local/sbin/lilac-entrypoint
COPY docker/create-operator-token.mjs /usr/local/libexec/create-operator-token.mjs
# Build steps run as root, so hardening only needs to verify source permissions.
# Avoid recursively rewriting dependencies in a source-invalidated layer.
RUN writable_path="$(find /app ! -type l -perm /022 -print -quit)" \
  && if [ -n "$writable_path" ]; then \
       ls -ld "$writable_path" >&2; \
       exit 1; \
     fi

ARG LILAC_BUILD_VERSION=dev
ARG LILAC_BUILD_COMMIT=dev
ARG LILAC_BUILD_DIRTY=false
ARG LILAC_BUILD_AT=
# Generate build metadata last so metadata-only changes create one tiny layer.
RUN mkdir -p /app/build && BUILD_AT_FRAGMENT="" && if [ -n "$LILAC_BUILD_AT" ]; then BUILD_AT_FRAGMENT=$(printf ',\n  "builtAt": "%s"' "$LILAC_BUILD_AT"); fi && printf '{\n  "version": "%s",\n  "commit": "%s",\n  "dirty": %s%s\n}\n' "$LILAC_BUILD_VERSION" "$LILAC_BUILD_COMMIT" "$LILAC_BUILD_DIRTY" "$BUILD_AT_FRAGMENT" > /app/build/build-info.json

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/sbin/lilac-entrypoint"]
CMD ["/usr/local/bin/bun", "apps/core/src/runtime/main.ts"]
