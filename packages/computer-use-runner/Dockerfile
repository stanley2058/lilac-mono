ARG BASE_IMAGE=trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b
FROM ${BASE_IMAGE}

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        chromium-sandbox \
        fonts-liberation2 \
        fonts-noto-core \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        mousepad \
        ristretto \
        engrampa \
        unzip \
        zip \
        libreoffice-writer \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-draw \
        libreoffice-gtk3 \
        openssh-server \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV VNC_RESOLUTION=1440x900

WORKDIR /home/cua

COPY runtime.py /opt/lilac-computer/runtime.py
COPY executor.conf /tmp/lilac-executor.conf
RUN cat /tmp/lilac-executor.conf >> /etc/supervisor/supervisord.conf \
    && rm /tmp/lilac-executor.conf
