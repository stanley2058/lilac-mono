ARG BASE_IMAGE=ubuntu:24.04
ARG NODE_MAJOR=22
ARG CONTAINER_UID=1000

############################
# Stage 1: sandbox tools
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
  bubblewrap \
  build-essential \
  cmake \
  dbus \
  dbus-user-session \
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
  libpam-systemd \
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
  systemd \
  systemd-sysv \
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

# The workflow sandbox presents /lib64 as /usr/lib. Expose Ubuntu's dynamic
# loader there as well so the bind-mounted Bun executable remains runnable.
RUN ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in \
       amd64) ln -s x86_64-linux-gnu/ld-linux-x86-64.so.2 /usr/lib/ld-linux-x86-64.so.2 ;; \
       arm64) ln -s aarch64-linux-gnu/ld-linux-aarch64.so.1 /usr/lib/ld-linux-aarch64.so.1 ;; \
     esac

ARG CONTAINER_UID
ENV LILAC_UID=${CONTAINER_UID}

# Create a dedicated regular user instead of inheriting an image account's
# groups or account settings. Ubuntu reserves UID/GID 1000 for `ubuntu`.
RUN case "$LILAC_UID" in \
      ''|*[!0-9]*) echo "CONTAINER_UID must be a numeric regular-user UID" >&2; exit 1 ;; \
    esac \
  && if [ "$LILAC_UID" -lt 1000 ] || [ "$LILAC_UID" -gt 60000 ]; then \
       echo "CONTAINER_UID must be between 1000 and 60000" >&2; exit 1; \
     fi \
  && if id -u "$LILAC_USER" >/dev/null 2>&1; then \
       userdel --remove "$LILAC_USER"; \
     fi \
  && existing_user="$(getent passwd "$LILAC_UID" | cut -d: -f1 || true)" \
  && if [ -n "$existing_user" ]; then \
       if [ "$existing_user" != "ubuntu" ]; then \
         echo "CONTAINER_UID is already assigned to a base-image account" >&2; exit 1; \
       fi; \
       userdel --remove ubuntu; \
     fi \
  && if getent group "$LILAC_USER" >/dev/null 2>&1; then \
       groupdel "$LILAC_USER"; \
     fi \
  && existing_group="$(getent group "$LILAC_UID" | cut -d: -f1 || true)" \
  && if [ -n "$existing_group" ]; then \
       if [ "$existing_group" != "ubuntu" ]; then \
         echo "CONTAINER_UID is already assigned to a base-image group" >&2; exit 1; \
       fi; \
       groupdel ubuntu; \
     fi \
  && groupadd --gid "$LILAC_UID" "$LILAC_USER" \
  && useradd --create-home --uid "$LILAC_UID" --gid "$LILAC_USER" \
       --shell /bin/bash "$LILAC_USER" \
  && [ "$(id -G "$LILAC_USER")" = "$LILAC_UID" ]
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
ENV XDG_RUNTIME_DIR=/run/user/${LILAC_UID}
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=${XDG_RUNTIME_DIR}/bus
ENV PATH=${BUN_INSTALL_BIN}:${NPM_CONFIG_PREFIX}/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

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
COPY packages/agent/package.json packages/agent/package.json
COPY packages/event-bus/package.json packages/event-bus/package.json
COPY packages/fs/package.json packages/fs/package.json
COPY packages/plugin-runtime/package.json packages/plugin-runtime/package.json
COPY packages/remote-fs-runner/package.json packages/remote-fs-runner/package.json
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
COPY bunfig.toml tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN chown -R ${LILAC_USER}:$(id -gn "${LILAC_USER}") /app
USER ${LILAC_USER}

# Build client bundles
RUN (cd apps/tool-bridge && bun run build)
RUN (cd apps/core && bun run build:remote-runner)
RUN (cd packages/remote-fs-runner && bun run build)

USER root
ARG LILAC_BUILD_VERSION=dev
ARG LILAC_BUILD_COMMIT=dev
ARG LILAC_BUILD_DIRTY=false
ARG LILAC_BUILD_AT=
# Generate build metadata late so commit-only changes do not invalidate source build layers.
RUN mkdir -p /app/build && BUILD_AT_FRAGMENT="" && if [ -n "$LILAC_BUILD_AT" ]; then BUILD_AT_FRAGMENT=$(printf ',\n  "builtAt": "%s"' "$LILAC_BUILD_AT"); fi && printf '{\n  "version": "%s",\n  "commit": "%s",\n  "dirty": %s%s\n}\n' "$LILAC_BUILD_VERSION" "$LILAC_BUILD_COMMIT" "$LILAC_BUILD_DIRTY" "$BUILD_AT_FRAGMENT" > /app/build/build-info.json
RUN chown -R ${LILAC_USER}:$(id -gn "${LILAC_USER}") /app/build
# Make `tools` available globally
RUN ln -sf /app/apps/tool-bridge/dist/index.js /usr/local/bin/tools

# The system manager starts both the per-user manager and Core. UID substitution
# happens at image build time so startup never generates or mutates unit files.
COPY docker/lilac-core.service /etc/systemd/system/lilac-core.service.in
COPY docker/user-manager-delegate.conf /etc/systemd/system/user@.service.d/delegate.conf
COPY --chmod=0755 docker/systemd-entrypoint.sh /usr/local/sbin/lilac-systemd-entrypoint
COPY docker/write-container-environment.mjs /usr/local/libexec/write-container-environment.mjs
COPY --chmod=0755 docker/verify-workflow-runtime.sh /usr/local/bin/verify-workflow-runtime
RUN sed "s/@LILAC_UID@/${LILAC_UID}/g" \
      /etc/systemd/system/lilac-core.service.in \
      > /etc/systemd/system/lilac-core.service \
  && rm /etc/systemd/system/lilac-core.service.in \
  && install -d -m 0755 /var/lib/systemd/linger \
  && touch /var/lib/systemd/linger/${LILAC_USER} \
  && ln -s /etc/systemd/system/lilac-core.service \
      /etc/systemd/system/multi-user.target.wants/lilac-core.service \
  && systemctl mask \
      console-getty.service \
      getty@.service \
      getty-static.service \
      serial-getty@.service \
      apt-daily.service \
      apt-daily.timer \
      apt-daily-upgrade.service \
      apt-daily-upgrade.timer \
      motd-news.service \
      motd-news.timer \
      systemd-udevd-control.socket \
      systemd-udevd-kernel.socket \
      systemd-udevd.service

STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/usr/local/sbin/lilac-systemd-entrypoint"]
CMD ["/sbin/init"]
