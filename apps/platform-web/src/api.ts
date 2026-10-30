import { authGeneration, unauthorizedDetail } from './auth-generation';
import { resolveInitialLocale, translate } from './i18n';
import type { PackageResult } from './types';

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

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * What a kernel error route answers with. `any` here used to mean every caller read
 * `body?.code` through an untyped hole; the four fields are the ones the kernel guarantees.
 */
type ErrorEnvelope = { code?: string; message?: string; requestId?: string; retryable?: boolean };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // The generation this request belongs to, read before the first `await`: a login or a
  // logout during the flight makes the result stale, and a stale 401 must not sign out the
  // session established after it went out (see auth-generation.ts).
  const ticket = authGeneration.ticket();
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
  let body: ErrorEnvelope | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('opsweave:unauthorized', { detail: unauthorizedDetail(ticket) }));
    }
    throw new ApiError(
      response.status,
      body?.code || 'HTTP_ERROR',
      body?.message || translate(resolveInitialLocale(), 'api.requestFailed', { status: response.status }),
      body?.requestId,
      Boolean(body?.retryable),
    );
  }
  // The route contract types the payload and only the route knows it; the double assertion is
  // the one place that gap is stated, instead of an `any` the whole module leaked.
  return body as unknown as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  postWithHeaders: <T>(path: string, body: unknown, headers: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), headers }),
  // Every POST is one operator action, and the kernel refuses the deployment routes without
  // this header - the install wizard could not deploy anything until it was sent. A caller
  // that retries the *same* logical operation must pass its own stable key, which is exactly
  // what the studio editor does for draft saves.
  post: <T>(path: string, body: unknown = {}, idempotencyKey?: string) =>
    request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'idempotency-key': idempotencyKey ?? newIdempotencyKey() },
    }),
  patch: <T>(path: string, body: unknown = {}) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown = {}, extraHeaders: Record<string, string> = {}) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body), headers: extraHeaders }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  uploadPackage: async (file: File): Promise<PackageResult> => {
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
    let body: ErrorEnvelope | null = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
    if (!response.ok) {
      throw new ApiError(
        response.status,
        body?.code || 'UPLOAD_FAILED',
        body?.message || translate(resolveInitialLocale(), 'api.packageUploadFailed'),
        body?.requestId,
        Boolean(body?.retryable),
      );
    }
    return body as unknown as PackageResult;
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
