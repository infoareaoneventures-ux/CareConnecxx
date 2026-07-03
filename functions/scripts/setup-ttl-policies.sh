#!/usr/bin/env bash
# Firestore TTL policies for Evia (one-time / idempotent).
#
# Firestore TTL is configured per collection-group on a Timestamp field; docs
# whose field value is in the past are auto-deleted (within ~24h). It is NOT
# expressed in firestore.rules/indexes, so it must be applied out-of-band — this
# script is the tracked source of truth for that ops step.
#
# `gcloud firestore fields ttls update` is idempotent: re-running it is safe and
# simply re-asserts the policy. Requires an authenticated gcloud with Datastore
# Owner/Editor on the project.
#
# Usage:
#   ./functions/scripts/setup-ttl-policies.sh                 # uses default project below
#   PROJECT=careconnex-d4c8b ./functions/scripts/setup-ttl-policies.sh
set -euo pipefail

PROJECT="${PROJECT:-careconnex-d4c8b}"

# collection-group : ttl-field
# - agent_imessage_retry: forced-iMessage retry tracking (6h ttl) — see
#   functions/src/linq/client.ts (trackForcedIMessage). Records that never
#   receive a message.delivered/failed event self-expire here.
# - agent_audit_log: HIPAA audit entries (6y ttl) — see
#   functions/src/observability/auditLog.ts.
declare -a POLICIES=(
  "agent_imessage_retry:ttl"
  "agent_audit_log:ttl"
)

for entry in "${POLICIES[@]}"; do
  group="${entry%%:*}"
  field="${entry##*:}"
  echo "Setting TTL policy: ${group}.${field} (project ${PROJECT})"
  gcloud firestore fields ttls update "${field}" \
    --collection-group="${group}" \
    --project="${PROJECT}" \
    --async
done

echo "Done. Verify with: gcloud firestore fields ttls list --collection-group=agent_imessage_retry --project=${PROJECT}"
