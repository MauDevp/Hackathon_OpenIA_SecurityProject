#!/usr/bin/env bash
# DMsecurity scheduled scan: scan one repository, keep the report, raise an alert.
#
# Usage:
#   scripts/scheduled-scan.sh <repository> [git-ref]
#
# Meant for cron or a systemd timer. It scans <git-ref> (default HEAD) of
# <repository> with the scanners installed by scripts/setup.sh, stores the
# report under $GUARDIA_STATE_DIR/<repo-name>/ (default ~/.local/state/guardia),
# appends one line to history.log, and on FINDINGS or INCOMPLETE sends a desktop
# notification through notify-send when it is available. Set
# GUARDIA_NOTIFY=whatsapp to queue a redacted WhatsApp alert for FINDINGS and
# INCOMPLETE, or GUARDIA_NOTIFY=none to disable notifications. The exit code is
# always the scan's: 0 PASS, 1 FINDINGS, 2 INCOMPLETE.
#
# Desktop notifications need the session bus. From cron, export it on the line:
#   0 9 * * 1-5 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /path/to/dmsecurity/scripts/scheduled-scan.sh /path/to/repo >> ~/.local/state/guardia/cron.log 2>&1
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARDIA_DIR="${GUARDIA_DIR:-$ROOT/.guardia}"
STATE_DIR="${GUARDIA_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/guardia}"
NOTIFICATION_STATE_DIR="${DMSECURITY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/dmsecurity}"
NOTIFY="${GUARDIA_NOTIFY:-desktop}"
NOTIFY_ON="${GUARDIA_NOTIFY_ON:-findings,incomplete}"
NODE_BIN="${DMSECURITY_NODE_BIN:-node}"

repo="${1:-}"
ref="${2:-HEAD}"
if [ -z "$repo" ] || [ "$repo" = "-h" ] || [ "$repo" = "--help" ]; then
  awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
  exit 2
fi
repo="$(cd "$repo" 2>/dev/null && pwd)" || { echo "scheduled-scan: repository not found: $1" >&2; exit 2; }
[ -x "$ROOT/dist/cli/index.js" ] || [ -f "$ROOT/dist/cli/index.js" ] || { echo "scheduled-scan: build missing, run 'npm run build' in $ROOT" >&2; exit 2; }

name="$(basename "$repo")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="$STATE_DIR/$name"
mkdir -p "$out_dir"
report="$out_dir/$stamp.json"

export GUARDIA_OSV_SCANNER_BIN="$GUARDIA_DIR/tools/osv-scanner"
export GUARDIA_GITLEAKS_BIN="$GUARDIA_DIR/tools/gitleaks"
export OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$GUARDIA_DIR/osv-db"
export DMSECURITY_STATE_DIR="$NOTIFICATION_STATE_DIR"

summary="$(cd "$ROOT" && "$NODE_BIN" dist/cli/index.js scan --repo "$repo" --ref "$ref" --out "$report" 2>&1)"
code=$?
printf '%s\n' "$summary"

status="$(printf '%s\n' "$summary" | sed -n 's/^guardia: \([A-Z]*\).*/\1/p' | head -1)"
findings="$(printf '%s\n' "$summary" | sed -n 's/^findings: \([0-9]*\)/\1/p' | head -1)"
commit="$(printf '%s\n' "$summary" | sed -n 's/^commit: \([0-9a-f]\{7\}\).*/\1/p' | head -1)"
[ -n "$status" ] || status="ERROR"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$stamp" "$name" "${commit:-unknown}" "$status" "${findings:-0}" "$report" >> "$STATE_DIR/history.log"
ln -sfn "$report" "$out_dir/latest.json"

if [ "$code" -ne 0 ] && [ "$NOTIFY" = "desktop" ] && command -v notify-send >/dev/null; then
  case "$status" in
    FINDINGS) urgency=critical; text="${findings:-?} finding(s) in $name @ ${commit:-unknown}" ;;
    *)        urgency=normal;   text="scan of $name is $status; see $report" ;;
  esac
  notify-send --app-name=DMsecurity --urgency="$urgency" "DMsecurity: $status" "$text" || true
fi

if [ "$NOTIFY" = "whatsapp" ]; then
  notification="$(cd "$ROOT" && "$NODE_BIN" dist/cli/index.js notify --report "$report" --repo-alias "$name" --ref "$ref" --trigger scheduled --on "$NOTIFY_ON" 2>&1)"
  printf '%s\n' "$notification"
fi

exit "$code"
