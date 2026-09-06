import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (err) => logger.error({ err }, 'Redis error'));

/**
 * The admin service publishes chat events onto the same Socket.IO Redis
 * channel the user-api broadcasts on, so an admin reply reaches the user's
 * browser without admin-api running its own Socket.IO server.
 */
export const pubClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
pubClient.on('error', (err) => logger.error({ err }, 'Redis pub error'));
