# Examples

Opt-in integration examples. Nothing here runs unless you copy it into place.

| File | What it does |
| --- | --- |
| `scheduled-scan.yml` | GitHub Actions workflow: scans the repository on a schedule, uploads the report and opens or updates one issue when the result is not `PASS`. |
| `../scripts/scheduled-scan.sh` | Local equivalent for cron or a systemd timer: scans, keeps the report under `~/.local/state/guardia/` and sends a desktop notification. |

Hooks are never installed without explicit consent.
