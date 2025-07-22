# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt

# FastAPI/UVicorn runtime settings
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080          # Cloud Run will override this to 8080

# --- only this line changed ---
CMD ["sh", "-c", "python -m uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT}"]
