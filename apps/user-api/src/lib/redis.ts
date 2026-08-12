import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const createRedis = (label: string): Redis => {
  const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  client.on('error', (err) => logger.error({ err, label }, 'Redis error'));
  client.on('connect', () => logger.debug({ label }, 'Redis connected'));
  return client;
};

/** General-purpose client (rate limiting, ephemeral keys). */
export const redis = createRedis('app');
