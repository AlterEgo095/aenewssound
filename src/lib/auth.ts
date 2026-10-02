import crypto from "crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  AUTH_SECRET,
} from "@/lib/config";

// ---------------------------------------------------------------------------
// Mots de passe : scrypt versionné (sel aléatoire, paramètres encodés dans le
// hash, comparaison timing-safe). Format : scrypt$N$r$p$salt$hash.
// Les anciens hash "salt:hash" (défauts Node N=16384,r=8,p=1) restent vérifiés.
// ---------------------------------------------------------------------------

const SCRYPT_N = 32768; // 2^15 — compromis sécurité/coût serveur
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 128*N*r ≈ 33,6 Mo > défaut Node (32 Mo)
const SCRYPT_r = 8;
const SCRYPT_p = 1;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    // 128*N*r dépasse le maxmem par défaut de Node (32 Mo) : il faut le relever.
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  if (stored.startsWith("scrypt$")) {
    const [, nStr, rStr, pStr, rest] = stored.split("$");
    const [saltHex, hashHex] = (rest ?? "").split(":");
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!saltHex || !hashHex || !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    const expected = Buffer.from(hashHex, "hex");
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  }
  // Format historique (défauts Node) — vérifié tel quel.
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// ---------------------------------------------------------------------------
// Tokens : access = JWT HS256 signé ; refresh = opale aléatoire, stocké hashé.
// Rotation : chaque refresh crée une nouvelle session chaînée (rotatedFromId).
// Réutilisation d'un refresh déjà consommé => révocation de la famille.
// ---------------------------------------------------------------------------

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hmac(data: string): string {
  // Source unique : AUTH_SECRET dérive de config.ts (fail-fast en production).
  return crypto.createHmac("sha256", AUTH_SECRET).update(data).digest("base64url");
}

export type AccessPayload = {
  sub: string;
  role: string;
  deviceId: string;
  typ: "access";
  exp: number;
};

export function signAccessToken(
  claims: { sub: string; role: string; deviceId: string },
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(
    JSON.stringify({ ...claims, typ: "access", exp })
  ).toString("base64url");
  const signature = hmac(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

export function verifyAccessToken(token: string): AccessPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  // Garde-fou : l'algorithme est figé (pas d'alg=none / confusion HS/RS).
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: string };
    if (h.alg !== "HS256") return null;
  } catch {
    return null;
  }
  const expected = hmac(`${header}.${payload}`);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    ) as AccessPayload;
    if (parsed.typ !== "access" || parsed.exp * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Devices & sessions
// ---------------------------------------------------------------------------

export function getDeviceHeaders(req: Request): { deviceUid: string; platform: string } {
  const deviceUid = req.headers.get("x-device-id");
  if (!deviceUid || deviceUid.length < 8 || deviceUid.length > 128) {
    throw new ApiError(400, "En-tête X-Device-Id requis (identifiant client stable)");
  }
  const raw = req.headers.get("x-platform") ?? "WEB";
  const platform = ["ANDROID", "IOS", "WEB", "PWA"].includes(raw) ? raw : "WEB";
  return { deviceUid, platform };
}

export async function upsertDevice(userId: string, deviceUid: string, platform: string) {
  const existing = await db.userDevice.findUnique({
    where: { userId_deviceUid: { userId, deviceUid } },
  });
  if (existing) {
    return db.userDevice.update({
      where: { id: existing.id },
      data: { lastSeenAt: new Date(), platform },
    });
  }
  return db.userDevice.create({ data: { userId, deviceUid, platform } });
}

export async function createSession(opts: {
  userId: string;
  deviceId: string;
  req: Request;
  rotatedFromId?: string;
}) {
  const refreshToken = randomToken();
  const session = await db.userSession.create({
    data: {
      userId: opts.userId,
      deviceId: opts.deviceId,
      refreshHash: sha256(refreshToken),
      rotatedFromId: opts.rotatedFromId ?? null,
      ip: opts.req.headers.get("x-forwarded-for") ?? null,
      userAgent: opts.req.headers.get("user-agent")?.slice(0, 255) ?? null,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  });
  return { session, refreshToken };
}

export async function issueTokens(opts: {
  user: { id: string; role: string };
  deviceUid: string;
  platform: string;
  req: Request;
  rotatedFromId?: string;
}) {
  const device = await upsertDevice(opts.user.id, opts.deviceUid, opts.platform);
  const { session, refreshToken } = await createSession({
    userId: opts.user.id,
    deviceId: device.id,
    req: opts.req,
    rotatedFromId: opts.rotatedFromId,
  });
  const accessToken = signAccessToken({
    sub: opts.user.id,
    role: opts.user.role,
    deviceId: device.id,
  });
  return {
    accessToken,
    refreshToken,
    sessionId: session.id,
    deviceId: device.id,
  };
}

// ---------------------------------------------------------------------------
// Gardes d'API
// ---------------------------------------------------------------------------

export async function authenticate(req: Request) {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const payload = verifyAccessToken(authorization.slice(7));
  if (!payload) return null;
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.status !== "ACTIVE" || user.deletedAt) return null;
  return { user, payload };
}

export async function requireAuth(req: Request) {
  const ctx = await authenticate(req);
  if (!ctx) throw new ApiError(401, "Authentification requise");
  return ctx;
}

const STAFF_ROLES = ["ADMIN", "SUPER_ADMIN", "MODERATOR"];

export async function requireAdmin(req: Request) {
  const ctx = await requireAuth(req);
  if (!STAFF_ROLES.includes(ctx.user.role)) {
    throw new ApiError(403, "Accès réservé à l'équipe AENEWS");
  }
  return ctx;
}

export function publicUser(user: {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  role: string;
  locale: string;
  country: string | null;
}) {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    locale: user.locale,
    country: user.country,
  };
}
