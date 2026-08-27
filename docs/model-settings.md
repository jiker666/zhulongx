# Model Settings

The web console exposes `/settings/model` for an operator to configure an OpenAI-compatible model endpoint for the current API process.

The default form is prefilled for the Wanqing gateway setup:

- Base URL: `https://wanqing-api.corp.kuaishou.com/api/gateway/v1/endpoints`
- API: `openai-completions`
- Model ID: an operator-provided `ep-*` deployment endpoint
- Optional gateway header: `AppKey` (customizable for other gateways)
- Reasoning format: `deepseek` with explicit provider-side disable when the runtime uses `thinkingLevel: off`.

The reasoning format is an operator setting. It is not tied to any challenge or answer. For custom gateways, choose the wire format they document or leave it at `Provider default`.

API keys and AppKeys are accepted only over the local control-plane request and kept in process memory. They are not returned by `GET /v1/settings/model`, stored in `sessionStorage`, written to run artifacts, or included in audit records. Restarting the API clears page-configured credentials and falls back to the configured environment model.

For unattended deployments, use a private config overlay and environment variables instead of the page. A config overlay can set `model.reasoning`, `model.thinkingFormat`, and (when needed) `model.supportsReasoningEffort`. Never commit credentials or place them in task text, screenshots, or generated reports.
