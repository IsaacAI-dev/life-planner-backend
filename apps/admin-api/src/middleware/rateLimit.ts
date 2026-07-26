import rateLimit, { type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { ErrorCode, failEnvelope } from '@life-planner/shared-utils';
import { redisClient } from '../redis.js';

function makeStore(prefix: string): Store {
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redisClient.sendCommand(args),
  });
}

const rateLimitHandler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) => {
  res.status(429).json(failEnvelope(ErrorCode.RATE_LIMITED, 'Too many requests, slow down'));
};

export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:admin:general:'),
  handler: rateLimitHandler,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:admin:auth:'),
  handler: rateLimitHandler,
});
