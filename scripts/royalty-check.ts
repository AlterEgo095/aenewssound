import { PrismaClient } from "@prisma/client";
async function main() {
  const db = new PrismaClient();
  try {
    const lines = await db.royaltyLine.findMany({ select: { type: true, netAmountMinor: true, artistId: true } });
    console.log("LINES:", JSON.stringify(lines.map((l) => `${l.type}:${l.netAmountMinor}`)));
    const payouts = await db.payout.findMany({ include: { payee: true } });
    console.log("PAYOUTS:", JSON.stringify(payouts.map((p) => `${p.status}:${p.amountMinor}:${p.payee.displayName}`)));
    console.log("STATEMENTS:", await db.statement.count());
  } catch (e) { console.error("FAIL:", String(e).slice(0, 150)); }
  finally { await db.$disconnect(); }
}
main();
