#!/usr/bin/env bash
# Installs a user-local DMsecurity command without touching system directories.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${DMSECURITY_BIN_DIR:-$HOME/.local/bin}"
WRAPPER="$BIN_DIR/dmsecurity"

command -v node >/dev/null || {
  echo "dmsecurity command: Node.js 22+ is required." >&2
  exit 2
}

mkdir -p "$BIN_DIR"
if [ ! -e "$WRAPPER" ] || grep -q "DMsecurity local command" "$WRAPPER" 2>/dev/null; then
  NODE_BIN="$(command -v node)"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' '# DMsecurity local command'
    printf 'exec %q %q "$@"\n' "$NODE_BIN" "$ROOT/dist/cli/index.js"
  } > "$WRAPPER"
  chmod 700 "$WRAPPER"
  echo "dmsecurity command installed: $WRAPPER"
else
  echo "dmsecurity command: $WRAPPER belongs to another program; it was left unchanged" >&2
  exit 1
fi
