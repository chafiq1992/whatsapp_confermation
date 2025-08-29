#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./infra/cloud-run-deploy.sh <PROJECT_ID> <REGION> <SERVICE> <GAR_LOCATION> <REPOSITORY> <VPC_CONNECTOR> <REDIS_HOST> <GCS_BUCKET_NAME>
# Example:
#   ./infra/cloud-run-deploy.sh my-proj us-central1 whatsapp-backend us-central1 whatsapp cr-redis 10.0.0.5 my-bucket

PROJECT_ID=${1:-}
REGION=${2:-}
SERVICE=${3:-whatsapp-backend}
GAR_LOCATION=${4:-us-central1}
REPOSITORY=${5:-whatsapp}
VPC_CONNECTOR=${6:-cr-redis}
REDIS_HOST=${7:-}
GCS_BUCKET_NAME=${8:-}

if [[ -z "$PROJECT_ID" || -z "$REGION" || -z "$REDIS_HOST" || -z "$GCS_BUCKET_NAME" ]]; then
  echo "Required: PROJECT_ID REGION REDIS_HOST GCS_BUCKET_NAME"
  exit 1
fi

gcloud config set project "$PROJECT_ID"

IMAGE="$GAR_LOCATION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/$SERVICE:$(git rev-parse --short HEAD)"

echo "Building and pushing $IMAGE"
gcloud auth configure-docker "$GAR_LOCATION-docker.pkg.dev" --quiet
docker build -t "$IMAGE" .
docker push "$IMAGE"

echo "Deploying to Cloud Run: $SERVICE"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --vpc-connector "$VPC_CONNECTOR" \
  --vpc-egress private-ranges-only \
  --memory 1Gi \
  --set-env-vars "REDIS_URL=redis://$REDIS_HOST:6379" \
  --set-env-vars "ENABLE_WS_PUBSUB=1" \
  --set-env-vars "GCS_BUCKET_NAME=$GCS_BUCKET_NAME" \
  --set-env-vars "PORT=8080"

echo "Done. Service URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'


