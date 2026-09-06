import { createServer } from 'node:http';
import { prisma } from '@lifeplanner/database';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';
import { initSocketServer } from './realtime/socket.js';
import { startRealtimeBridge } from './realtime/bridge.js';
import { startRecurringJob } from './jobs/recurring.js';
import { startReminderJob } from './jobs/reminders.js';
import {
  startMessagePurgeJob,
  startSubscriptionSweepJob,
  startSuspensionSweepJob,
} from './jobs/retention.js';

const app = createApp();
const httpServer = createServer(app);

initSocketServer(httpServer);
startRealtimeBridge();

const jobs = env.ENABLE_JOBS
  ? [
      startRecurringJob(),
      startReminderJob(),
      // Addendum 3: 30-day purge of soft-deleted messages, and the lapse sweep.
      startMessagePurgeJob(),
      startSubscriptionSweepJob(),
      startSuspensionSweepJob(),
    ]
  : [];

httpServer.listen(env.USER_API_PORT, () => {
  logger.info(
    { port: env.USER_API_PORT, env: env.NODE_ENV, jobs: jobs.length },
    'user-api listening',
  );
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down user-api');
  for (const job of jobs) job.stop();
  httpServer.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
