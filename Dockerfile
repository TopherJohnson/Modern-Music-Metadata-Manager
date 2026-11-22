# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Build React + Vite + Tailwind CSS static frontend
# ==============================================================================
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend-builder

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Slim Python runtime serving FastAPI + compiled frontend assets
# ==============================================================================
FROM python:3.12-slim AS runtime

LABEL org.opencontainers.image.title="Modern Music Metadata Manager (M4)" \
      org.opencontainers.image.description="Self-hosted companion to Navidrome for inspecting and editing audio metadata on disk." \
      org.opencontainers.image.source="https://github.com/TopherJohnson/Modern-Music-Metadata-Manager"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    M4_MUSIC_DIR=/music \
    M4_CONFIG_DIR=/config \
    M4_STATIC_DIR=/app/static \
    PUID=1000 \
    PGID=1000

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 m4 \
    && useradd -u 1000 -g 1000 -m -s /bin/bash m4 \
    && mkdir -p /app /app/static /music /config \
    && chown -R m4:m4 /app /config

WORKDIR /app

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=m4:m4 backend/app ./app
COPY --from=frontend-builder --chown=m4:m4 /build/frontend/dist ./static
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import sys, urllib.request; r = urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4); sys.exit(0 if r.status == 200 else 1)"

# Entrypoint remaps the non-root `m4` user to PUID/PGID and drops privileges with gosu.
# Containers launched with `--user UID:GID` are also supported and skip privilege drop.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
