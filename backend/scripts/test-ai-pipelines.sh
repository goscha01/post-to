#!/usr/bin/env bash
# Smoke-test the two AI endpoints. Run against a running backend.
#
# Usage:
#   export BACKEND_URL=http://localhost:3001
#   export JWT_TOKEN=...        # auth token from your /auth flow
#   ./scripts/test-ai-pipelines.sh
#
# Optional:
#   export REVIEW_ID=<gmb_reviews.id or review_id>  # tests /api/reviews/:id/generate-post

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
: "${JWT_TOKEN:?JWT_TOKEN env var is required}"

AUTH_HEADER="Authorization: Bearer ${JWT_TOKEN}"

echo "=== 1. Article generation ==="
curl -sS -X POST "${BACKEND_URL}/api/ai/articles" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Spotless Homes",
    "businessType": "residential cleaning company",
    "service": "deep cleaning",
    "city": "Tampa",
    "keyword": "deep cleaning Tampa",
    "tone": "helpful, local, professional",
    "targetAudience": "homeowners and renters in Florida"
  }' | tee /tmp/post-to-article.json
echo

echo "=== 2. Review-post generation (raw input) ==="
curl -sS -X POST "${BACKEND_URL}/api/ai/review-post" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Spotless Homes",
    "businessType": "residential cleaning company",
    "city": "Tampa",
    "reviewText": "The team was on time, kind, and my kitchen has never looked this good. Will book again.",
    "reviewRating": 5,
    "reviewerName": "Jamie",
    "platform": "google",
    "tone": "warm, grateful, professional"
  }' | tee /tmp/post-to-review-post.json
echo

if [[ -n "${REVIEW_ID:-}" ]]; then
  echo "=== 3. Review-post generation (stored review id) ==="
  curl -sS -X POST "${BACKEND_URL}/api/reviews/${REVIEW_ID}/generate-post" \
    -H "${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -d '{}' | tee /tmp/post-to-review-post-by-id.json
  echo
fi

echo "Done."
