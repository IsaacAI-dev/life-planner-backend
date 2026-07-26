import rateLimit, { type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { ErrorCode, failEnvelope } from '@life-planner/shared-utils';
import { redisClient } from '../redis.js';

/**
 * Redis-backed store so limits hold across instances (§12). We lazily build a
 * store per limiter with a distinct prefix. If Redis isn't connected yet at
 * import time, express-rate-limit calls into the store at request time.
 */
function makeStore(prefix: string): Store {
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redisClient.sendCommand(args),
  });
}

const rateLimitHandler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) => {
  res.status(429).json(failEnvelope(ErrorCode.RATE_LIMITED, 'Too many requests, slow down'));
};

/** General API limiter. */
export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:general:'),
  handler: rateLimitHandler,
});

/** Tight limiter for auth endpoints (login/register/refresh). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:auth:'),
  handler: rateLimitHandler,
});

/** Tight limiter for chat message sends. */
export const messageLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:msg:'),
  handler: rateLimitHandler,
});
