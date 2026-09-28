# syntax=docker/dockerfile:1

# ---- 1. build the frontend -------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite writes the bundle to ../backend/static
RUN mkdir -p ../backend && npm run build

# ---- 2. python runtime -----------------------------------------------------
FROM python:3.12-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PINPOINT_DATA_DIR=/data \
    PINPOINT_STATIC_DIR=/app/static

WORKDIR /app
COPY backend/pyproject.toml ./
RUN uv pip install --system --no-cache -r pyproject.toml

COPY backend/app ./app
COPY --from=frontend /src/backend/static ./static

RUN useradd --system --uid 10001 pinpoint && mkdir -p /data && chown pinpoint /data
USER pinpoint
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/')" || exit 1

# One worker on purpose: the game lives in memory and every phone must reach the same process.
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--ws-ping-interval", "20"]
