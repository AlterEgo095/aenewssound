import { NextResponse } from "next/server";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function handle(
  fn: () => Promise<Response>
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    console.error("[api]", e);
    return NextResponse.json({ error: "Erreur interne du serveur" }, { status: 500 });
  }
}

export async function parseBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, "Corps JSON invalide");
  }
}

// Rate limiting en mémoire (phase 1 — remplacé par Redis sliding window en prod).
const buckets = new Map<string, { count: number; reset: number }>();

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    if (buckets.size > 10_000) buckets.clear();
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new ApiError(429, "Trop de requêtes, réessayez plus tard");
  }
  bucket.count += 1;
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

export function requireString(
  value: unknown,
  field: string,
  maxLength = 255
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, `Champ requis manquant : ${field}`);
  }
  if (value.length > maxLength) {
    throw new ApiError(400, `Champ trop long : ${field}`);
  }
  return value.trim();
}

export function requirePhone(value: unknown): string {
  const phone = requireString(value, "phone", 20);
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new ApiError(400, "Numéro invalide — format E.164 attendu (ex: +243...)");
  }
  return phone;
}
