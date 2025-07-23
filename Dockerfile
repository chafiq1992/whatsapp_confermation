FROM python:3.12-slim

WORKDIR /app
COPY . .
# Ensure the built frontend is included
COPY frontend/build ./frontend/build
RUN pip install --no-cache-dir -r backend/requirements.txt

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

CMD ["sh", "-c", "python -m uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT}"]
