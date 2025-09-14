// lib/prisma.ts
import { PrismaClient } from '@/app/generated/prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { withOptimize } from '@prisma/extension-optimize';

/**
 * Approach:
 * 1) Create a typed base PrismaClient (so TS sees the generated types from @prisma/client).
 * 2) If running in production, create the adapter (Neon) and pass it when instantiating the client.
 *    If the adapter's typings cause trouble, cast the adapter to `any` only for the constructor argument.
 * 3) Optionally call $extends(...) on the base client. Let TypeScript infer the returned extended client.
 */

// create the base client with explicit branch so TS can infer model types
function createBasePrisma() {
  if (process.env.NODE_ENV === 'production') {
    // if the adapter's types are incompatible in your TS setup,
    // cast it to `any` just for the argument so the PrismaClient type remains intact.
    // This avoids widening the whole expression to `any`, which is the root of your problem.
    const adapter = new PrismaNeon({
      connectionString: process.env.DATABASE_URL!,
    }) as unknown as any;

    return new PrismaClient({ adapter });
  }

  // non-production: plain client
  return new PrismaClient();
}

// instantiate basePrisma (typed as PrismaClient)
const basePrisma = createBasePrisma();

// optionally extend the client in prod
const prisma =
  process.env.NODE_ENV === 'production' && process.env.OPTIMIZE_API_KEY
    ? basePrisma.$extends(withOptimize({ apiKey: process.env.OPTIMIZE_API_KEY! }))
    : basePrisma;

// Dev hot-reload guard
declare global {
  // eslint-disable-next-line no-var
  var __prisma: typeof prisma;
}

if (process.env.NODE_ENV !== 'production') {
  if (!globalThis.__prisma) {
    globalThis.__prisma = prisma;
  }
}

const exportedPrisma = process.env.NODE_ENV === 'production' ? prisma : globalThis.__prisma!;

export default exportedPrisma;
export type Prisma = typeof exportedPrisma;
