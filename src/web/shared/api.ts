/** Shared JSON `fetch` wrapper used by every web page for calls to the server's `/api/*` routes. */

/**
 * Fetches `path` as JSON and returns the parsed body. Non-2xx responses throw an `Error` whose
 * `.message` is the server's `{error}` body field (falling back to `HTTP <status>`) — this lets
 * every caller just `try/catch` a single `Error` with a human-readable message instead of
 * re-checking `res.ok` at every call site.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Cheap "am I logged in" probe: reuses the auth-gated `/api/state` endpoint rather than adding a
 * dedicated one — the session cookie already answers this implicitly via the 401 it gets back. */
export async function isLoggedIn(): Promise<boolean> {
  try {
    await api("/api/state");
    return true;
  } catch {
    return false;
  }
}
