# syntax=docker/dockerfile:1
# ------------------------------------------------------------
# FastAPI + Uvicorn container for Google Cloud Run
# ------------------------------------------------------------
FROM python:3.12-slim

# ---------- optional system deps ----------
# If you have wheels that need compilation, uncomment the next lines.
# RUN apt-get update && apt-get install -y --no-install-recommends \
#         build-essential \
#     && rm -rf /var/lib/apt/lists/*

# ---------- python deps ----------
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---------- project files ----------
COPY . .

# ---------- runtime env ----------
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080         # Cloud Run will override this to 8080, so keep the default

EXPOSE 8080

# ---------- start ----------
# Use *shell* form so ${PORT} is expanded before uvicorn sees it.
CMD uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT}
