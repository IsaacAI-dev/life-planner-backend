import { createServer } from 'node:http';
import { env } from './env.js';
import { logger } from './logger.js';
import { connectRedis, redisClient } from './redis.js';

async function main(): Promise<void> {
  await connectRedis();

  // Imported dynamically *after* Redis is connected: the rate-limit middleware
  // builds its RedisStore at module-eval time and that constructor issues a
  // Redis command, so the client must already be open before these load.
  const { createApp } = await import('./app.js');
  const { attachSockets } = await import('./sockets/index.js');
  const { startJobs } = await import('./jobs/index.js');

  const app = createApp();
  const httpServer = createServer(app);

  const io = await attachSockets(httpServer);
  const jobs = startJobs();

  httpServer.listen(env.USER_API_PORT, () => {
    logger.info({ port: env.USER_API_PORT, env: env.NODE_ENV }, 'user-api listening');
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'shutting down user-api');
    jobs.forEach((j) => j.stop());
    await io.close();
    httpServer.close();
    if (redisClient.isOpen) await redisClient.quit();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal: user-api failed to start');
  process.exit(1);
});
