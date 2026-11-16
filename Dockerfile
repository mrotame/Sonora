# Sonora acquisition backend (server/ + shared/), for Cloud Run.
# Node >= 24 runs the .ts files directly (type stripping), so there is no build step
# and no npm install: the server only uses Node built-ins.
FROM node:24-slim

# yt-dlp standalone binary (no Python needed). YouTube breaks extractors often, so the default
# is the latest release; pin with --build-arg YTDLP_VERSION=2025.xx.xx for reproducible builds.
ARG YTDLP_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && if [ "$YTDLP_VERSION" = "latest" ]; then \
      url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"; \
    else \
      url="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux"; \
    fi \
 && curl -fsSL "$url" -o /usr/local/bin/yt-dlp \
 && chmod 0755 /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Use the Node already in the image as yt-dlp's JavaScript runtime (YouTube extraction needs one).
RUN echo "--js-runtimes node" > /etc/yt-dlp.conf

WORKDIR /app
COPY package.json ./
COPY shared ./shared
COPY server ./server

# Cloud Run injects PORT; it must listen on all interfaces and sits behind Google's proxy.
ENV HOST=0.0.0.0 \
    TRUST_PROXY=1 \
    NODE_ENV=production

USER node
EXPOSE 8080
CMD ["node", "server/index.ts"]
