#!/usr/bin/env bash
# One-time setup of free-tier guards for the Sonora backend on GCP.
# Run manually (Cloud Shell or local gcloud), NOT from CI. Not executed or verified by the author:
# check each command with `gcloud ... --help` before running.
#
# Usage:
#   PROJECT_ID=my-project REGION=us-central1 BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
#   BUDGET_AMOUNT=1 ./deploy/gcp-free-tier-guards.sh
set -euo pipefail

: "${PROJECT_ID:?}" "${REGION:?}" "${BILLING_ACCOUNT:?}"
# Must be in the billing account's currency (e.g. 1 = US$1 or R$1).
BUDGET_AMOUNT="${BUDGET_AMOUNT:-1}"
# Repository created automatically by `gcloud run deploy --source` / deploy-cloudrun `source:`.
AR_REPO="${AR_REPO:-cloud-run-source-deploy}"
# Bucket where `source:` uploads the code for Cloud Build.
SOURCE_BUCKET="gs://run-sources-${PROJECT_ID}-${REGION}"

gcloud services enable billingbudgets.googleapis.com artifactregistry.googleapis.com --project "$PROJECT_ID"

# 1) Budget alert. It only NOTIFIES (emails billing admins); it does not stop the service.
gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT" \
  --display-name="sonora-free-tier-guard" \
  --budget-amount="${BUDGET_AMOUNT}" \
  --filter-projects="projects/${PROJECT_ID}" \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=1.0

# 2) Artifact Registry: keep only the 2 most recent images, delete the rest after 1 day.
policy="$(mktemp)"
cat > "$policy" <<'JSON'
[
  {
    "name": "keep-latest-2",
    "action": { "type": "Keep" },
    "mostRecentVersions": { "keepCount": 2 }
  },
  {
    "name": "delete-older",
    "action": { "type": "Delete" },
    "condition": { "tagState": "any", "olderThan": "1d" }
  }
]
JSON
# --no-dry-run applies the policy (the default is a dry run that deletes nothing).
gcloud artifacts repositories set-cleanup-policies "$AR_REPO" \
  --project "$PROJECT_ID" --location "$REGION" \
  --policy="$policy" --no-dry-run
rm -f "$policy"

# 3) Source upload bucket: delete uploaded source archives after 1 day.
lifecycle="$(mktemp)"
cat > "$lifecycle" <<'JSON'
{ "rule": [ { "action": { "type": "Delete" }, "condition": { "age": 1 } } ] }
JSON
gcloud storage buckets update "$SOURCE_BUCKET" --lifecycle-file="$lifecycle"
rm -f "$lifecycle"

echo "Done. Also set the Cloud Run region to a free-tier region (e.g. us-central1) and re-check pricing."
