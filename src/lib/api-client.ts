"use client";

import { ensureDeviceId, useAuthStore } from "@/lib/stores";

export class ApiClientError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean; // défaut : true
  idempotencyKey?: string;
  retryOn401?: boolean;
};

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const { refreshToken, setSession, clear } = useAuthStore.getState();
  if (!refreshToken) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-id": ensureDeviceId(),
            "x-platform": "WEB",
          },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          clear();
          return false;
        }
        const data = (await res.json()) as {
          user: Parameters<typeof setSession>[0]["user"];
          accessToken: string;
          refreshToken: string;
        };
        setSession(data);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
  }
  return refreshing;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const useAuth = opts.auth !== false;
  const { accessToken } = useAuthStore.getState();

  const headers: Record<string, string> = {
    "x-device-id": ensureDeviceId(),
    "x-platform": "WEB",
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (useAuth && accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 401 && useAuth && opts.retryOn401 !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) return api<T>(path, { ...opts, retryOn401: false });
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? ((await res.json()) as unknown) : null;

  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; code?: string };
    throw new ApiClientError(res.status, err.error ?? `Erreur ${res.status}`, err.code);
  }
  return data as T;
}
