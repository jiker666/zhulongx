export class ApiError extends Error { constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; } }

const baseURL = import.meta.env.VITE_API_BASE_URL ?? "";

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(`${baseURL}${path}`, { ...options, signal, headers: { accept: "application/json", ...options.headers } });
    const text = await response.text();
    let body: unknown = undefined;
    try { body = text ? JSON.parse(text) : undefined; } catch { throw new ApiError(response.status, "服务返回了无法解析的数据"); }
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? String(body.error) : `请求失败（HTTP ${response.status}）`;
      throw new ApiError(response.status, message);
    }
    return body as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiError(408, "请求超时或已取消");
    throw error;
  } finally { window.clearTimeout(timer); }
}
