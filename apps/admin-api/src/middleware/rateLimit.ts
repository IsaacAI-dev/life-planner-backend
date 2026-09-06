import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { ErrorCode, fail } from '@lifeplanner/shared-utils';
import { redis } from '../lib/redis.js';

const base = (prefix: string, windowMs: number, max: number): Partial<Options> => ({
  windowMs,
  limit: max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
  }),
  handler: (_req, res) => {
    res.status(429).json(fail(ErrorCode.RATE_LIMITED, 'Too many requests, please slow down'));
  },
});

export const adminGeneralLimiter = rateLimit(base('rl:admin:', 60_000, 300));
export const adminAuthLimiter = rateLimit(base('rl:adminauth:', 15 * 60_000, 20));
