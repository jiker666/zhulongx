# Model Settings

The web console exposes `/settings/model` for an operator to configure an Anthropic-protocol model endpoint for the current API process. Every embedded agent session — including writeup generation — routes through the loopback model gateway, which injects the real credential upstream and strips anything the client sent.

The default form is prefilled with a neutral placeholder:

- Base URL: `https://api.anthropic.com` (replace with your gateway or relay)
- Model ID: `deepseek-v4-flash` by default; any model id your endpoint serves
- Optional gateway header: `AppKey` (customizable header name for gateway deployments)
- `reasoning` records whether the endpoint supports controllable extended thinking; the runtime maps its `thinkingLevel` setting to the SDK thinking budget.

Only Anthropic-protocol endpoints are supported. The gateway speaks `/v1/messages`; OpenAI Chat Completions and Responses wire formats were removed with the legacy agent loop.

API keys and AppKeys are accepted only over the local control-plane request and kept in process memory. They are not returned by `GET /v1/settings/model`, stored in `sessionStorage`, written to run artifacts, or included in audit records. Restarting the API clears page-configured credentials and falls back to the configured environment model.

For unattended deployments, use a private config overlay and environment variables instead of the page. A config overlay can set `model.baseUrl`, `model.id`, `model.apiKeyEnv` (default `XUANSHU_MODEL_API_KEY`), and `model.authScheme` (`bearer` or `api-key`). Never commit credentials or place them in task text, screenshots, or generated reports.
