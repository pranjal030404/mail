export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';
export const setCsrfToken = (t: string) => {
  csrfToken = t;
};

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}), accept: 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the ARTHVEX service. Check your connection and try again.');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: unknown; correlationId?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? 'Something went wrong. Please try again.', e?.details, e?.correlationId);
  }
  return json as T;
}

export const get = <T,>(p: string) => api<T>('GET', p);
export const post = <T,>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T,>(p: string, b: unknown = {}) => api<T>('PUT', p, b);
export const patch = <T,>(p: string, b: unknown = {}) => api<T>('PATCH', p, b);
export const del = <T,>(p: string, b?: unknown) => api<T>('DELETE', p, b);

export function fieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && Array.isArray(err.details)) {
    return Object.fromEntries((err.details as { field: string; message: string }[]).map((d) => [d.field, d.message]));
  }
  return {};
}

export const errorText = (err: unknown): string => (err instanceof ApiError ? err.message : 'Something went wrong.');
