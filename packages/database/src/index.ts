import { PrismaClient } from './generated/client/index.js';

/**
 * Prisma client singleton.
 *
 * In dev, hot-reload (tsx watch) can repeatedly re-evaluate modules and
 * exhaust the DB connection pool. Caching on globalThis prevents that.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Re-export the generated client + all model/enum types so consumers only
// ever import from "@life-planner/database".
export * from './generated/client/index.js';
export { PrismaClient };
