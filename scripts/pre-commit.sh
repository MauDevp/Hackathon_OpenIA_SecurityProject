#!/usr/bin/env bash
# DMsecurity pre-commit hook runner. Installed only through `guardia hook install`.
set -uo pipefail

mode="block"
notify="none"
notify_on="findings,incomplete"
node_bin="${DMSECURITY_NODE_BIN:-node}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --notify) notify="${2:-}"; shift 2 ;;
    --on) notify_on="${2:-}"; shift 2 ;;
    *) echo "dmsecurity hook: unknown option $1" >&2; exit 2 ;;
  esac
done

if [ "$mode" != "block" ] && [ "$mode" != "warn" ]; then
  echo "dmsecurity hook: mode must be warn or block" >&2
  exit 2
fi
if [ "$notify" != "none" ] && [ "$notify" != "whatsapp" ]; then
  echo "dmsecurity hook: notify must be none or whatsapp" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guardia_dir="${GUARDIA_DIR:-$root/.guardia}"
repo="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "dmsecurity hook: not inside a Git repository" >&2
  exit 2
}
report="${TMPDIR:-/tmp}/dmsecurity-staged-${PPID}-${RANDOM}.json"
trap 'rm -f "$report"' EXIT

export GUARDIA_OSV_SCANNER_BIN="$guardia_dir/tools/osv-scanner"
export GUARDIA_GITLEAKS_BIN="$guardia_dir/tools/gitleaks"
export OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$guardia_dir/osv-db"

args=(check-staged --repo "$repo" --out "$report")
if [ "$notify" = "whatsapp" ]; then
  args+=(--notify whatsapp --notify-on "$notify_on")
fi

"$node_bin" "$root/dist/cli/index.js" "${args[@]}"
code=$?
if [ "$code" -ne 0 ] && [ "$mode" = "warn" ]; then
  echo "dmsecurity hook: allowing commit because mode is warn" >&2
  exit 0
fi
exit "$code"
