# zhulongx agent image for TSecBench managed mode.
# Build context is assembled by build.sh (engine binary + live skills + configs).
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive TERM=xterm
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      binutils gdb \
      curl wget netcat-openbsd iputils-ping dnsutils \
      openssh-client unzip xz-utils file git jq ca-certificates \
      ripgrep fd-find nmap \
      hydra john \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Python attack/RE stack (installed at build time; runtime is offline)
RUN pip3 install --no-cache-dir --break-system-packages \
      pwntools capstone unicorn keystone-engine pyelftools \
      z3-solver pycryptodome requests \
      sqlmap flask-unsign dirsearch pyjwt

# Offline wordlists (staged under docker/build/wordlists; no build-time fetch)
COPY build/wordlists /usr/share/wordlists
RUN wc -l /usr/share/wordlists/web/*.txt /usr/share/wordlists/passwords/*.txt /usr/share/wordlists/secrets/*.txt

# pi agent runtime, pinned to the version validated in local benchmark rounds
RUN npm install -g @mariozechner/pi-coding-agent@0.73.1

# engine (linux/amd64, CGO-free) + configs + skills
COPY build/zhulongx /opt/zhx/zhulongx
COPY build/managed.yaml /opt/zhx/managed.yaml
COPY build/entrypoint.sh /opt/zhx/entrypoint.sh
COPY build/inject-facts.sh /opt/zhx/inject-facts.sh
COPY build/pi-settings.json /opt/zhx/pi-settings.json
COPY build/pi-models.gw.json /opt/zhx/pi-models.gw.json
COPY build/pi-models.local.json /opt/zhx/pi-models.local.json
COPY build/local-toolbox.container.md /opt/zhx/local-toolbox.container.md
RUN chmod +x /opt/zhx/zhulongx /opt/zhx/entrypoint.sh /opt/zhx/inject-facts.sh

# skills land in the pi config dir at build time; entrypoint swaps local-toolbox
COPY build/skills /root/.pi/agent/skills
RUN echo '{}' > /root/.pi/agent/auth.json && echo '{}' > /root/.pi/agent/trust.json

WORKDIR /work
ENTRYPOINT ["/opt/zhx/entrypoint.sh"]
