# Resource Export

`resource-export` reads a JSON array from a scoped workspace file, performs one bounded `GET` per resource, and writes a JSON report. Network requests are evaluated by `PolicyEngine` against the selected full config; `--scope` can only narrow that config. The command requires `scope.mode=controlled` and an exact `allowedHosts` entry for the endpoint host.

```bash
RESOURCE_EXPORT_ENDPOINT='http://127.0.0.1:3000/export' \
RESOURCE_EXPORT_APP_ID="$APP_ID" \
RESOURCE_EXPORT_AUTH_KEY="$AUTH_KEY" \
npm run dev -- resource-export \
  --ids task_ids.json \
  --output resource-export-report.json \
  --config config/resource-export.local.yaml
```

The model route map is read from `RESOURCE_EXPORT_MODEL_ROUTES` as a JSON object. It defaults to `{"default":"default"}` and can be selected with `--model`. Credentials are read only for request headers and are not placed in reports or audit records. The report contains `successful`, `failed`, `successRate`, and the required warning when the rate is below 80%.

Side effects are limited to scoped `GET` requests, a JSONL audit chain under `runtime.artifactRoot/resource-export/`, and the selected report path. Responses are bounded, redirects are not followed, an `AbortSignal` cancels waiting and fetches, requests start at least 500ms apart, and each resource uses at most three `Accept` values: JSON, plain text, then XML.
