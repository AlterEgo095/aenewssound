import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

// AuditLog — append-only (aucun UPDATE/DELETE applicatif).
//
// `tx` : quand l'audit fait partie d'une transaction métier ($transaction), il
// DOIT passer par le MÊME client Prisma — SQLite est single-writer : un write
// via la connexion globale pendant une transaction ouverte = contention de
// verrou → timeout P2028 (bug corrigé lors de l'audit v1.1).

export async function audit(
  entry: {
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
    userAgent?: string | null;
  },
  tx?: Prisma.TransactionClient
) {
  const c: Prisma.TransactionClient | typeof db = tx ?? db;
  return c.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 255) ?? null,
    },
  });
}
