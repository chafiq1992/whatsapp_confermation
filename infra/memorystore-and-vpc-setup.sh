#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./infra/memorystore-and-vpc-setup.sh <PROJECT_ID> <REGION> <CONNECTOR_NAME> <REDIS_NAME>
# Example:
#   ./infra/memorystore-and-vpc-setup.sh my-project us-central1 cr-redis my-redis

PROJECT_ID=${1:-}
REGION=${2:-}
CONNECTOR_NAME=${3:-cr-redis}
REDIS_NAME=${4:-my-redis}
NETWORK=${NETWORK:-default}

if [[ -z "$PROJECT_ID" || -z "$REGION" ]]; then
  echo "PROJECT_ID and REGION are required"
  exit 1
fi

gcloud config set project "$PROJECT_ID"
gcloud services enable redis.googleapis.com vpcaccess.googleapis.com --quiet

set +e
gcloud compute networks vpc-access connectors describe "$CONNECTOR_NAME" --region "$REGION" >/dev/null 2>&1
EXISTS=$?
set -e
if [[ "$EXISTS" -ne 0 ]]; then
  echo "Creating VPC connector $CONNECTOR_NAME in $REGION..."
  gcloud compute networks vpc-access connectors create "$CONNECTOR_NAME" \
    --region "$REGION" \
    --network "$NETWORK" \
    --range "10.8.0.0/28"
else
  echo "VPC connector $CONNECTOR_NAME already exists"
fi

set +e
gcloud redis instances describe "$REDIS_NAME" --region "$REGION" >/dev/null 2>&1
EXISTS=$?
set -e
if [[ "$EXISTS" -ne 0 ]]; then
  echo "Creating Memorystore instance $REDIS_NAME in $REGION..."
  gcloud redis instances create "$REDIS_NAME" \
    --region "$REGION" \
    --tier=BASIC \
    --size=1 \
    --redis-version=REDIS_7_0 \
    --network "$NETWORK"
else
  echo "Memorystore instance $REDIS_NAME already exists"
fi

HOST=$(gcloud redis instances describe "$REDIS_NAME" --region "$REGION" --format="value(host)")
PORT=$(gcloud redis instances describe "$REDIS_NAME" --region "$REGION" --format="value(port)")
echo "Memorystore host: $HOST"
echo "Memorystore port: $PORT"
echo "Use REDIS_URL=redis://$HOST:$PORT and VPC connector: $CONNECTOR_NAME"


