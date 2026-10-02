import { db } from "@/lib/db";

// AuditLog — append-only (aucun UPDATE/DELETE applicatif).

export async function audit(entry: {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.auditLog.create({
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
