export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    signal: init.signal,
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-acc-csrf': '1' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('acc:unauthorized'));
    throw new ApiError(res.status, data.error ?? `Erreur ${res.status}`);
  }
  return data as T;
}
