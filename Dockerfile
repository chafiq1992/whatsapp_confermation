# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt

# Cloud Run sends the port in $PORT; FastAPI already listens on it.
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host=0.0.0.0", "--port=${PORT:-8080}"]
