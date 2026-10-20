#!/usr/bin/env bash
# Fail if a retired service host is written as a reachable address.
#
#   scripts/check-host-literals.sh [path...]
#
# Scans for https://…atum.network and https://…atumlabs.xyz. Bare mentions
# (changelog / "deprecated" prose) are allowed. did:web: identifiers are
# stripped before the scan. After the protocol client that exports `hosts`
# is published, widen this to require SSOT URLs only (CORE-3184).
set -euo pipefail

TARGETS=("$@")
[ "${#TARGETS[@]}" -gt 0 ] || TARGETS=(.)
SELF="$(basename "$0")"
status=0

for target in "${TARGETS[@]}"; do
  if [ ! -e "$target" ]; then
    echo "$SELF: $target does not exist; nothing was scanned." >&2
    exit 2
  fi
done

EXCLUDES=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude="$SELF")

hits="$(grep -rnE "${EXCLUDES[@]}" -- 'https?://[^[:space:]"'\'']*(atum\.network|atumlabs\.xyz)' "${TARGETS[@]}" || true)"
# Strip did:web: lines so the corporate issuer identity is not a finding.
if [ -n "$hits" ]; then
  hits="$(printf '%s\n' "$hits" | grep -v 'did:web:' || true)"
fi

if [ -n "$hits" ]; then
  echo "Found a retired service host written as a reachable address:"
  echo "$hits"
  echo "  Use the published client's defaultGateway (or GATEWAY_URL), not a retired host."
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "No retired service hosts under ${TARGETS[*]}."
fi
exit "$status"
