# Schemas

Versioned JSON Schemas (draft-07) for the artifacts Guardia writes. A schema
file is named after the `formatVersion` it describes and is never edited in
place once published: a breaking change to the report gets a new
`formatVersion` and a new file.

| File | Describes | Validated by |
| --- | --- | --- |
| `guardia-report-1.0.schema.json` | The JSON report written by `guardia scan --out` | `tests/core/report-schema.test.ts` |

Validate a report by hand:

```bash
npx ajv-cli validate -s schemas/guardia-report-1.0.schema.json -d /tmp/guardia-report.json
```
