ARG DEBIAN_IMAGE=debian:bookworm-slim

############################
# Stage 1: sandbox tools
############################
FROM ${DEBIAN_IMAGE} AS tools
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  git \
  gnupg \
  pinentry-curses \
  jq \
  ripgrep \
  fd-find \
  tar \
  gzip \
  unzip \
  python3 \
  python3-venv \
  python3-pip \
  python-is-python3 \
  nodejs \
  npm \
  chromium \
  sqlite3 \
  openssh-client \
  fonts-liberation \
  fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# Debian calls it "fdfind"
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Non-root user (needed for bun/npm global installs)
RUN useradd -m -u 1000 -s /bin/bash lilac
ENV HOME=/home/lilac
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
RUN chown -R lilac:lilac $DATA_DIR

USER lilac

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
RUN chown -R lilac:lilac /app
USER lilac

# Bun workspace install (single install at repo root)
RUN bun install --frozen-lockfile
USER root

############################
# Stage 3: build + runtime entry
############################

FROM deps AS build
WORKDIR /app
COPY . .
RUN chown -R lilac:lilac /app
USER lilac

# Build the tool-bridge client bundle
RUN (cd apps/tool-bridge && bun run build)
USER root
# Make `tools` available globally
RUN ln -sf /app/apps/tool-bridge/dist/index.js /usr/local/bin/tools
USER lilac
# Entrypoint: core runtime
CMD ["bun", "apps/core/src/runtime/main.ts"]
