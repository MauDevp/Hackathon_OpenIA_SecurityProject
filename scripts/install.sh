#!/usr/bin/env bash
# One-command DMsecurity installation and interactive local configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v npm >/dev/null || {
  echo "install: Node.js 22+ and npm are required before installation." >&2
  exit 2
}

npm install
npm run setup -- "$@"
