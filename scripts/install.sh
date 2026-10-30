#!/usr/bin/env bash
# One-command DMsecurity installation and interactive local configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null && command -v npm >/dev/null || {
  echo "install: Node.js 22+ and npm are required before installation." >&2
  exit 2
}

node_major="$(node -p 'process.versions.node.split(".")[0]')"
case "$node_major" in
  ''|*[!0-9]*) echo "install: could not determine the installed Node.js version." >&2; exit 2 ;;
esac
if [ "$node_major" -lt 22 ]; then
  echo "install: Node.js 22+ is required (found $(node --version))." >&2
  exit 2
fi

npm ci
npm run setup -- "$@"
bash "$ROOT/scripts/install-command.sh"
