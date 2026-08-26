# Model Settings

The web console exposes `/settings/model` for an operator to configure an OpenAI-compatible model endpoint for the current API process.

The default form is prefilled for the Wanqing/Ark-style setup:

- Base URL: `https://ark.cn-beijing.volces.com/api/v3`
- API: `openai-completions`
- Model ID: an operator-provided `ep-*` deployment endpoint
- Optional gateway header: `X-App-Key`

API keys and AppKeys are accepted only over the local control-plane request and kept in process memory. They are not returned by `GET /v1/settings/model`, stored in `sessionStorage`, written to run artifacts, or included in audit records. Restarting the API clears page-configured credentials and falls back to the configured environment model.

For unattended deployments, use a private config overlay and environment variables instead of the page. Never commit credentials or place them in task text, screenshots, or generated reports.
