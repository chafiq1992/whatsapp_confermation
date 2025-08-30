# Build the React frontend first
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend .
RUN npm run build

FROM python:3.12-slim

# Install system dependencies required for building Python packages like
# ``uvloop`` and ``httptools`` which rely on C extensions.  ``build-essential``
# and ``gcc`` provide the toolchain, while the development libraries supply the
# necessary headers for compilation.
RUN apt-get update && apt-get install -y \
    build-essential \
    gcc \
    libffi-dev \
    libuv1 \
    libuv1-dev \
    python3-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
COPY --from=frontend-builder /app/frontend/build ./frontend/build
RUN pip install --no-cache-dir -r backend/requirements.txt

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

CMD ["sh", "-c", "python -m uvicorn backend.main:app --host 0.0.0.0 --port ${PORT} --loop uvloop --http httptools --proxy-headers --forwarded-allow-ips='*' --log-level ${LOG_LEVEL:-info}"]
