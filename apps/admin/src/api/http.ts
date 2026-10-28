export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface Hooks {
  onUnauthorized: () => void;
  onForbidden: () => void;
  onError: (message: string) => void;
}

let hooks: Hooks = { onUnauthorized() {}, onForbidden() {}, onError() {} };

export function configureHttp(h: Hooks): void {
  hooks = h;
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** 为 true 时不触发全局错误提示（由调用方自行展示） */
  silent?: boolean;
}

export function buildQuery(query: RequestOpts['query']): string {
  if (!query) return '';
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}

export async function request<T = unknown>(path: string, o: RequestOpts = {}): Promise<T> {
  const res = await fetch(`/api/admin${path}${buildQuery(o.query)}`, {
    method: o.method ?? 'GET',
    headers: o.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.ok) return (await res.json().catch(() => ({}))) as T;

  const message = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '请求失败';
  if (res.status === 401 && path !== '/login') {
    hooks.onUnauthorized();
    throw new ApiError('登录已过期，请重新登录', 401);
  }
  if (res.status === 403) hooks.onForbidden();
  else if (!o.silent) hooks.onError(message);
  throw new ApiError(message, res.status);
}
