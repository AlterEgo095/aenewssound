import fs from "fs";
import path from "path";
import crypto from "crypto";

// Stockage privé local — adaptateur sandbox de l'interface R2 (v1.1 §11).
// Les clés suivent les mêmes conventions que les buckets R2 :
//   masters/… audio/… artwork/… waveform/… statements/… exports/…
// Le dossier n'est PAS servi statiquement : tout accès passe par des URLs signées.

const ROOT = path.join(process.cwd(), "db", "storage");

export function resolveKey(key: string): string {
  const resolved = path.resolve(ROOT, key);
  if (!resolved.startsWith(ROOT)) {
    throw new Error(`Clé de stockage invalide : ${key}`);
  }
  return resolved;
}

export function putObject(key: string, data: Buffer) {
  const filePath = resolveKey(key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
  return {
    key,
    size: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
  };
}

export function putJsonObject(key: string, value: unknown) {
  return putObject(key, Buffer.from(JSON.stringify(value), "utf-8"));
}

export function objectPath(key: string): string | null {
  const filePath = resolveKey(key);
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  } catch {
    return null;
  }
  return filePath;
}

export function objectBuffer(key: string): Buffer | null {
  const filePath = objectPath(key);
  return filePath ? fs.readFileSync(filePath) : null;
}

export function contentTypeForKey(key: string): string {
  if (key.endsWith(".wav")) return "audio/wav";
  if (key.endsWith(".m4a") || key.endsWith(".mp4")) return "audio/mp4";
  if (key.endsWith(".mp3")) return "audio/mpeg";
  if (key.endsWith(".svg")) return "image/svg+xml";
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
