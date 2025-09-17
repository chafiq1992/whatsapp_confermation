#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/gcs_setup.sh YOUR_BUCKET

BUCKET="$1"

echo "Enforcing UBLA and Public Access Prevention on gs://$BUCKET" >&2
gsutil uniformbucketlevelaccess set on gs://"$BUCKET"
gsutil pap set enforced gs://"$BUCKET"

echo "Removing allUsers viewer if exists" >&2
set +e
gsutil iam ch -d allUsers:objectViewer gs://"$BUCKET"
set -e

TMP_CORS=$(mktemp)
cat > "$TMP_CORS" <<'JSON'
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD"],
    "responseHeader": [
      "Accept-Ranges",
      "Content-Range",
      "Content-Length",
      "Content-Type",
      "ETag",
      "Last-Modified",
      "Range"
    ],
    "maxAgeSeconds": 86400
  }
]
JSON

echo "Applying CORS for Range playback" >&2
gsutil cors set "$TMP_CORS" gs://"$BUCKET"
rm -f "$TMP_CORS"

echo "Done. Ensure your service account can sign URLs and set GCS_PUBLIC_UPLOADS=0." >&2


