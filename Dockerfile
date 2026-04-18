# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/ui/package.json ./packages/ui/
COPY packages/web/package.json ./packages/web/
COPY packages/desktop/package.json ./packages/desktop/
COPY packages/vscode/package.json ./packages/vscode/
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .
RUN bun run build:web

FROM oven/bun:1 AS runtime
WORKDIR /home/openchamber

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  git \
  less \
  nodejs \
  npm \
  openssh-client \
  python3 \
  curl gnupg\
  && rm -rf /var/lib/apt/lists/*
RUN install -m 0755 -d /etc/apt/keyrings && \
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg &&\
chmod a+r /etc/apt/keyrings/docker.gpg &&\
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null &&\
apt update &&\
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin golang-go


# Replace the base image's 'bun' user (UID 1000) with 'openchamber'
# so mounted volumes with 1000:1000 ownership work correctly.
RUN userdel bun \
  && groupdel docker &&  groupadd -g 988 docker \ 
 && groupadd -g 1000 openchamber \
  && useradd -u 1000 -g 1000 -m -s /bin/bash openchamber \
  && chown -R openchamber:openchamber /home/openchamber
 
# Switch to openchamber user
USER openchamber

ENV NPM_CONFIG_PREFIX=/home/openchamber/.npm-global
ENV PATH=${NPM_CONFIG_PREFIX}/bin:${PATH}

RUN npm config set prefix /home/openchamber/.npm-global && mkdir -p /home/openchamber/.npm-global && \
  mkdir -p /home/openchamber/.local /home/openchamber/.config /home/openchamber/.ssh && \
  npm install -g opencode-ai

# cloudflared 2026.3.0 - update digest explicitly when upgrading
COPY --from=cloudflare/cloudflared@sha256:6b599ca3e974349ead3286d178da61d291961182ec3fe9c505e1dd02c8ac31b0 /usr/local/bin/cloudflared /usr/local/bin/cloudflared

ENV NODE_ENV=production

COPY scripts/docker-entrypoint.sh /home/openchamber/openchamber-entrypoint.sh

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/web/package.json ./packages/web/package.json
COPY --from=builder /app/packages/web/bin ./packages/web/bin
COPY --from=builder /app/packages/web/server ./packages/web/server
COPY --from=builder /app/packages/web/dist ./packages/web/dist

EXPOSE 3000
USER root
RUN apt-get update && apt-get install -y curl build-essential gh && \
    curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin --channel LTS --install-dir /usr/local/share/dotnet && \
    echo 'export DOTNET_ROOT=/usr/local/share/dotnet' >> /etc/bash.bashrc && \
    echo 'export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools' >> /etc/bash.bashrc && \
    echo "export DOTNET_NUGET_GLOBAL_PACKAGES=/home/openchamber/.nuget" >>/etc/bash.bashrc && \
    echo "#!/bin/bash" > /start.sh && \
    echo '/home/openchamber/openchamber-entrypoint.sh&' >> /start.sh && \
    echo "cloudflared tunnel run --token eyJhIjoiMTkxYzkzYWU3OTZmZDkwNGU2ZGQ4Y2FjM2Q3MjI1OTgiLCJ0IjoiNmY1ZDQ2N2YtYzQ3NC00ZGE3LWFmNTktZTNmOGNkNjMyMGZhIiwicyI6IlpEazFNVGRtTnpNdE9HUmpaUzAwTTJRMExXSmlOV1l0WkRFNE4yUXdObUl5TnpZeiJ9" >> /start.sh &&\
    usermod -a -G docker openchamber&&\
    chmod a+x /start.sh && \
    apt-get clean  && \
    rm -rf /var/lib/apt/lists/*
USER openchamber
#ENTRYPOINT [ "/start.sh" ]

ENTRYPOINT ["sh", "/home/openchamber/openchamber-entrypoint.sh"]
