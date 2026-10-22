export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  retryable: boolean;

  constructor(status: number, code: string, message: string, requestId?: string, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
  }
}

let csrfToken = '';

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body && !(init.body instanceof Blob)) {
    headers.set('content-type', 'application/json');
  }
  if (csrfToken && init.method && init.method !== 'GET' && init.method !== 'HEAD') {
    headers.set('x-csrf-token', csrfToken);
  }
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('opsweave:unauthorized'));
    }
    throw new ApiError(
      response.status,
      body?.code || 'HTTP_ERROR',
      body?.message || `Request failed (${response.status})`,
      body?.requestId,
      Boolean(body?.retryable),
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown = {}, idempotencyKey?: string) =>
    request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    }),
  patch: <T>(path: string, body: unknown = {}) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  uploadPackage: async (file: File) => {
    const response = await fetch('/api/v1/plugins/packages', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/octet-stream',
        'x-csrf-token': csrfToken,
        'idempotency-key': newIdempotencyKey(),
      },
      body: file,
    });
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
    if (!response.ok) {
      throw new ApiError(
        response.status,
        body?.code || 'UPLOAD_FAILED',
        body?.message || 'Package upload failed',
        body?.requestId,
        Boolean(body?.retryable),
      );
    }
    return body;
  },
  gatewayGet: <T>(pluginId: string, path: string) =>
    request<T>(`/api/v1/gateway/${encodeURIComponent(pluginId)}${path}`),
  gatewayPost: <T>(pluginId: string, path: string, body: unknown, idempotencyKey?: string) =>
    request<T>(`/api/v1/gateway/${encodeURIComponent(pluginId)}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    }),
};
