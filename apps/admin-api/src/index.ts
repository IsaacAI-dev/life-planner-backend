import { prisma } from '@lifeplanner/database';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';

const app = createApp();

const server = app.listen(env.ADMIN_API_PORT, () => {
  logger.info({ port: env.ADMIN_API_PORT, env: env.NODE_ENV }, 'admin-api listening');
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down admin-api');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
