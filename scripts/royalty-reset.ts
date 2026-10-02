import { PrismaClient } from "@prisma/client";
async function main() {
  const db = new PrismaClient();
  try {
    const period = await db.royaltyPeriod.findFirst({ orderBy: { periodStart: "desc" } });
    const del = await db.royaltyLine.deleteMany({ where: { periodId: period!.id } });
    await db.royaltyPeriod.update({ where: { id: period!.id }, data: { status: "OPEN", closedAt: null } });
    await db.auditLog.create({
      data: {
        action: "system.demo_royalty_reset",
        entityType: "RoyaltyPeriod",
        entityId: period!.id,
        after: JSON.stringify({ reason: "Taux demo corrige 1->20 FC/ecoute (division entiere)", linesDeleted: del.count }),
      },
    });
    console.log("OK periode -> OPEN, lignes supprimees:", del.count);
  } catch (e) {
    console.error("FAIL:", e);
  } finally {
    await db.$disconnect();
  }
}
main();
