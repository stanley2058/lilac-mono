ARG BASE_IMAGE=ubuntu:24.04
ARG NODE_MAJOR=22
ARG CONTAINER_USER=lilac
ARG CONTAINER_UID=1000

############################
# Stage 1: sandbox tools
############################
FROM ${BASE_IMAGE} AS tools
ARG NODE_MAJOR
ARG CONTAINER_USER
ARG CONTAINER_UID
ENV LILAC_USER=${CONTAINER_USER}
ENV LILAC_UID=${CONTAINER_UID}
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
  unzip \
  vulkan-tools \
  && ARCH="$(dpkg --print-architecture)" \
  && if [ "$ARCH" = "amd64" ]; then \
       apt-get install -y --no-install-recommends google-chrome-stable; \
     fi \
  && rm -rf /var/lib/apt/lists/*

# Ubuntu/Debian call it "fdfind"
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Non-root user (needed for bun/npm global installs)
RUN if id -u "$LILAC_USER" >/dev/null 2>&1; then \
      if [ "$(id -u "$LILAC_USER")" != "$LILAC_UID" ]; then \
        usermod -u "$LILAC_UID" "$LILAC_USER"; \
      fi; \
      usermod -d "/home/$LILAC_USER" -m -s /bin/bash "$LILAC_USER"; \
    elif getent passwd "$LILAC_UID" >/dev/null 2>&1; then \
      existing_user="$(getent passwd "$LILAC_UID" | cut -d: -f1)"; \
      usermod -l "$LILAC_USER" "$existing_user"; \
      usermod -d "/home/$LILAC_USER" -m -s /bin/bash "$LILAC_USER"; \
      if getent group "$existing_user" >/dev/null 2>&1; then \
        groupmod -n "$LILAC_USER" "$existing_user"; \
      fi; \
    else \
      useradd -m -u "$LILAC_UID" -s /bin/bash "$LILAC_USER"; \
    fi
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
ENV PATH=${BUN_INSTALL_BIN}:${NPM_CONFIG_PREFIX}/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN mkdir -p $DATA_DIR $DATA_DIR/secret
RUN chown -R ${LILAC_USER}:$(id -gn "${LILAC_USER}") $DATA_DIR

USER ${LILAC_USER}

# uv (user-level)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
# bun (user-level)
RUN curl -fsSL https://bun.sh/install | bash
USER root

############################
# Stage 2: deps
############################

FROM tools AS deps
WORKDIR /app
# Copy only dependency manifests for layer caching
COPY package.json bun.lock ./
COPY apps/core/package.json apps/core/package.json
COPY apps/tool-bridge/package.json apps/tool-bridge/package.json
COPY apps/opencode-controller/package.json apps/opencode-controller/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/event-bus/package.json packages/event-bus/package.json
COPY packages/utils/package.json packages/utils/package.json
RUN chown -R ${LILAC_USER}:$(id -gn "${LILAC_USER}") /app
USER ${LILAC_USER}

# Bun workspace install (single install at repo root)
RUN bun install --frozen-lockfile
USER root

############################
# Stage 3: build + runtime entry
############################

FROM deps AS build
WORKDIR /app
COPY . .
RUN chown -R ${LILAC_USER}:$(id -gn "${LILAC_USER}") /app
USER ${LILAC_USER}

# Build client bundles
RUN (cd apps/tool-bridge && bun run build)
RUN (cd apps/core && bun run build:remote-runner)

USER root
# Make `tools` available globally
RUN ln -sf /app/apps/tool-bridge/dist/index.js /usr/local/bin/tools
USER ${LILAC_USER}
# Entrypoint: core runtime
CMD ["bun", "apps/core/src/runtime/main.ts"]
