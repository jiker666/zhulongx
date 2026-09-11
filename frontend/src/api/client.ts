export class ApiError extends Error { constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; } }

const baseURL = import.meta.env.VITE_API_BASE_URL ?? "";
const serverTokenKey = "xuanshu-server-token";

// localStorage (not sessionStorage): operators pin a stable token in .env, so
// the browser should remember it across sessions instead of per-tab re-entry.
export function getServerToken(): string {
  return window.localStorage.getItem(serverTokenKey) ?? "";
}

export function setServerToken(value: string): void {
  const token = value.trim();
  if (token) window.localStorage.setItem(serverTokenKey, token);
  else window.localStorage.removeItem(serverTokenKey);
}

export function authorizedHeaders(): Record<string, string> {
  const token = getServerToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function apiURL(path: string): string {
  return `${baseURL}${path}`;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(apiURL(path), { ...options, signal, headers: { accept: "application/json", ...authorizedHeaders(), ...options.headers } });
    const text = await response.text();
    let body: unknown = undefined;
    try { body = text ? JSON.parse(text) : undefined; } catch { throw new ApiError(response.status, "服务返回了无法解析的数据"); }
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event("xuanshu:unauthorized"));
      const message = body && typeof body === "object" && "error" in body ? String(body.error) : `请求失败（HTTP ${response.status}）`;
      throw new ApiError(response.status, message);
    }
    return body as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiError(408, "请求超时或已取消");
    throw error;
  } finally { window.clearTimeout(timer); }
}
