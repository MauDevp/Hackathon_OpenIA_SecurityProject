#!/usr/bin/env bash
# DMsecurity setup: install the pinned scanners and the OSV offline database.
#
# Usage:
#   scripts/setup.sh [--lockfile <path>]... [--refresh-db] [--skip-db] [--no-onboard]
#
# Installs OSV-Scanner and Gitleaks into <repo>/.guardia/tools after verifying
# their SHA-256 against the values recorded in docs/scanners.md, then downloads
# one OSV advisory database per lockfile given (default: the npm fixture, which
# fetches the npm database). Re-running is safe: present binaries with the
# right version are kept, and so is a present database when no --lockfile is
# given; an explicit --lockfile or --refresh-db always downloads.
#
# Override the install location with GUARDIA_DIR (default: <repo>/.guardia).
# Linux x86_64 only; other platforms follow docs/scanners.md by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARDIA_DIR="${GUARDIA_DIR:-$ROOT/.guardia}"
TOOLS_DIR="$GUARDIA_DIR/tools"
DB_DIR="$GUARDIA_DIR/osv-db"

OSV_VERSION="2.7.0"
OSV_ASSET="osv-scanner_linux_amd64"
OSV_SHA256="160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b"
OSV_URL="https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}/${OSV_ASSET}"

GITLEAKS_VERSION="8.30.1"
GITLEAKS_ASSET="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
# SHA-256 of the extracted `gitleaks` binary, as recorded in docs/scanners.md.
GITLEAKS_SHA256="88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509"
GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ASSET}"

OSV_SOURCE_BASE="https://osv-vulnerabilities.storage.googleapis.com"

lockfiles=()
refresh_db=0
skip_db=0
onboard=1
while [ $# -gt 0 ]; do
  case "$1" in
    --lockfile)
      [ $# -ge 2 ] || { echo "setup: --lockfile needs a path" >&2; exit 2; }
      lockfiles+=("$2"); shift 2 ;;
    --refresh-db) refresh_db=1; shift ;;
    --skip-db) skip_db=1; shift ;;
    --no-onboard) onboard=0; shift ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "setup: unknown option '$1'" >&2; exit 2 ;;
  esac
done
if [ "$skip_db" -eq 1 ] && [ ${#lockfiles[@]} -gt 0 ]; then
  echo "setup: --skip-db cannot be combined with --lockfile" >&2; exit 2
fi
if [ ${#lockfiles[@]} -eq 0 ]; then
  lockfiles=("$ROOT/fixtures/adapters/npm-vulnerable/package-lock.json")
fi

log() { printf 'setup: %s\n' "$*"; }
fail() { printf 'setup: %s\n' "$*" >&2; exit 1; }

os="$(uname -s)"; arch="$(uname -m)"
[ "$os" = "Linux" ] && [ "$arch" = "x86_64" ] \
  || fail "only Linux x86_64 is automated here ($os $arch detected); follow docs/scanners.md"
for cmd in curl sha256sum tar install; do
  command -v "$cmd" >/dev/null || fail "'$cmd' is required"
done

mkdir -p "$TOOLS_DIR" "$DB_DIR"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

verify() { # verify <file> <sha256>
  echo "$2  $1" | sha256sum --check --status || fail "checksum mismatch for $1"
}

# --- OSV-Scanner -------------------------------------------------------------
if [ -x "$TOOLS_DIR/osv-scanner" ] && "$TOOLS_DIR/osv-scanner" --version 2>/dev/null | head -1 | grep -q "version: $OSV_VERSION"; then
  log "osv-scanner $OSV_VERSION already installed"
else
  log "downloading osv-scanner $OSV_VERSION"
  curl -fsSL --retry 3 -o "$work/$OSV_ASSET" "$OSV_URL"
  verify "$work/$OSV_ASSET" "$OSV_SHA256"
  install -m 0755 "$work/$OSV_ASSET" "$TOOLS_DIR/osv-scanner"
  log "osv-scanner installed: $("$TOOLS_DIR/osv-scanner" --version | head -1)"
fi

# --- Gitleaks ----------------------------------------------------------------
if [ -x "$TOOLS_DIR/gitleaks" ] && [ "$("$TOOLS_DIR/gitleaks" version 2>/dev/null)" = "$GITLEAKS_VERSION" ]; then
  log "gitleaks $GITLEAKS_VERSION already installed"
else
  log "downloading gitleaks $GITLEAKS_VERSION"
  curl -fsSL --retry 3 -o "$work/$GITLEAKS_ASSET" "$GITLEAKS_URL"
  tar -xzf "$work/$GITLEAKS_ASSET" -C "$work" gitleaks
  verify "$work/gitleaks" "$GITLEAKS_SHA256"
  install -m 0755 "$work/gitleaks" "$TOOLS_DIR/gitleaks"
  log "gitleaks installed: $("$TOOLS_DIR/gitleaks" version)"
fi

# --- OSV offline database ----------------------------------------------------
if [ "$skip_db" -eq 1 ]; then
  log "database download skipped (--skip-db)"
else
  existing=0
  [ -d "$DB_DIR/osv-scalibr" ] && existing="$(find "$DB_DIR/osv-scalibr" -name all.zip | wc -l)"
  if [ "$existing" -gt 0 ] && [ "$refresh_db" -eq 0 ] && [ ${#lockfiles[@]} -eq 1 ] && [ "${lockfiles[0]}" = "$ROOT/fixtures/adapters/npm-vulnerable/package-lock.json" ]; then
    log "offline database already present ($existing ecosystem(s)); use --refresh-db to update"
  else
    for lockfile in "${lockfiles[@]}"; do
      [ -f "$lockfile" ] || fail "lockfile not found: $lockfile"
      log "downloading the advisory database for $(basename "$lockfile") (this can take a few minutes)"
      set +e
      OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$DB_DIR" "$TOOLS_DIR/osv-scanner" scan \
        --offline --download-offline-databases -L "$lockfile" --format json >/dev/null 2>"$work/osv.err"
      code=$?
      set -e
      # 0 = no findings, 1 = findings, 128 = empty lockfile; anything else is a download or parse failure.
      case "$code" in 0|1|128) ;; *) sed 's/^/  /' "$work/osv.err" >&2; fail "osv-scanner exited $code while downloading the database" ;; esac
    done
  fi

  # Sidecar read by the OSV adapter to report `database.downloadedAt`.
  meta="$DB_DIR/guardia-db-meta.json"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Copy the previous sidecar first: the redirect below truncates $meta before the loop reads it.
  prev_meta="$work/meta-previous.json"
  [ -f "$meta" ] && cp "$meta" "$prev_meta" || : > "$prev_meta"
  {
    printf '{\n  "tool": "osv-scanner",\n  "toolVersion": "%s",\n  "databases": {' "$OSV_VERSION"
    first=1
    while IFS= read -r zip; do
      [ -n "$zip" ] || continue
      eco="$(basename "$(dirname "$zip")")"
      sum="$(sha256sum "$zip" | cut -d' ' -f1)"
      rel="${zip#"$DB_DIR"/}"
      # Keep an earlier downloadedAt when the file did not change.
      prev="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const d=(m.databases||{})[process.argv[2]];if(d&&d.sha256===process.argv[3]&&d.downloadedAt)process.stdout.write(d.downloadedAt)' "$prev_meta" "$eco" "$sum" 2>/dev/null || true)"
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    "%s": {\n      "path": "%s",\n      "downloadedAt": "%s",\n      "sha256": "%s",\n      "sourceDate": null,\n      "source": "%s/%s/all.zip"\n    }' \
        "$eco" "$rel" "${prev:-$now}" "$sum" "$OSV_SOURCE_BASE" "$eco"
    done < <([ -d "$DB_DIR/osv-scalibr" ] && find "$DB_DIR/osv-scalibr" -name all.zip | sort)
    printf '\n  }\n}\n'
  } > "$meta"
  log "database metadata written to ${meta#"$ROOT"/}"
fi

cat <<MSG

setup: done. Scanners in ${TOOLS_DIR#"$ROOT"/}, databases in ${DB_DIR#"$ROOT"/}.
MSG

if [ "$onboard" -eq 1 ] && [ -t 0 ] && [ -t 1 ]; then
  log "starting the interactive configuration"
  export GUARDIA_OSV_SCANNER_BIN="$TOOLS_DIR/osv-scanner"
  export GUARDIA_GITLEAKS_BIN="$TOOLS_DIR/gitleaks"
  export OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$DB_DIR"
  node "$ROOT/dist/cli/index.js" onboard
elif [ "$onboard" -eq 1 ]; then
  log "interactive configuration skipped (no terminal); run 'guardia onboard' from a terminal when ready"
fi
