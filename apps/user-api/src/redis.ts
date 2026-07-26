import { createClient } from 'redis';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * One base client; the Socket.IO Redis adapter needs a pub + sub pair (duplicated
 * from this base). The same connection backs the rate-limit store.
 */
export const redisClient = createClient({ url: env.REDIS_URL });
redisClient.on('error', (err) => logger.error({ err }, 'Redis client error'));

export async function connectRedis(): Promise<void> {
  if (!redisClient.isOpen) await redisClient.connect();
}

export function makePubSubPair() {
  const pub = redisClient.duplicate();
  const sub = redisClient.duplicate();
  pub.on('error', (err) => logger.error({ err }, 'Redis pub error'));
  sub.on('error', (err) => logger.error({ err }, 'Redis sub error'));
  return { pub, sub };
}
