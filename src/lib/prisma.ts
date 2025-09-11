// lib/prisma.ts
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { withOptimize } from '@prisma/extension-optimize';

// Explicitly define the type of Prisma client with extensions
type ExtendedPrismaClient = ReturnType<typeof prismaClientFactory>;

function prismaClientFactory() {
  if (process.env.NODE_ENV === 'production') {
    const adapter = new PrismaNeon({
      connectionString: process.env.DATABASE_URL!,
    });

    return new PrismaClient({ adapter }).$extends(
      withOptimize({ apiKey: process.env.OPTIMIZE_API_KEY! })
    );
  }

  return new PrismaClient();
}

// Avoid multiple instances in dev (hot reload)
const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedPrismaClient | undefined;
};

export const prisma: ExtendedPrismaClient = globalForPrisma.prisma ?? prismaClientFactory();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
