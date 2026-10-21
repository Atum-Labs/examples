#!/usr/bin/env bash
# Fail if a retired service host is written as a reachable address.
#
#   scripts/check-host-literals.sh [path...]
#
# Scans for http(s):// and wss:// …atum.network / …atumlabs.xyz. Bare mentions
# (changelog / "deprecated" prose) are allowed. Only the did:web: token is
# stripped, not the whole line — a retired URL next to an issuer DID still
# fails. After the protocol client that exports `hosts` is published, widen
# this to require SSOT URLs only (CORE-3184).
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

URL_RE='(https?|wss?)://[^[:space:]"'\'']*(atum\.network|atumlabs\.xyz)'
hits="$(grep -rnE "${EXCLUDES[@]}" -- "$URL_RE" "${TARGETS[@]}" || true)"
# Remove only the DID token. Dropping the whole line hid a retired URL that
# sat next to did:web:atumlabs.xyz.
if [ -n "$hits" ]; then
  hits="$(printf '%s\n' "$hits" | sed -E 's/did:web:[^[:space:]"'\'',]*//g' | grep -E "$URL_RE" || true)"
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
