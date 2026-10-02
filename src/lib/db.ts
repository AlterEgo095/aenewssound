import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Query logging en dev uniquement : en production, les requêtes contiennent
    // refreshHash, IP, UA — ni le bruit ni ces données ne doivent finir en logs.
    log:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn']
        : ['query', 'error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db