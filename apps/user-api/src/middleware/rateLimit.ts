import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { ErrorCode, fail } from '@lifeplanner/shared-utils';
import { redis } from '../lib/redis.js';

const store = (prefix: string) =>
  new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
  });

const base = (prefix: string, windowMs: number, max: number): Partial<Options> => ({
  windowMs,
  limit: max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: store(prefix),
  handler: (_req, res) => {
    res.status(429).json(fail(ErrorCode.RATE_LIMITED, 'Too many requests, please slow down'));
  },
});

/** Broad limiter applied to all /api/v1 traffic. */
export const generalLimiter = rateLimit(base('rl:general:', 60_000, 300));

/** Tight limiter for credential endpoints. */
export const authLimiter = rateLimit({
  ...base('rl:auth:', 15 * 60_000, 20),
  skipSuccessfulRequests: false,
});

/** Chat sends. */
export const messageLimiter = rateLimit(base('rl:msg:', 60_000, 60));

/**
 * Addendum 2 §21 — the public analytics endpoint gets its own generously-sized
 * bucket, distinct from authLimiter/messageLimiter, keyed by session where
 * available so one shared IP (office/NAT) doesn't starve everyone behind it.
 */
export const analyticsLimiter = rateLimit({
  ...base('rl:analytics:', 60_000, 600),
  keyGenerator: (req) => {
    const sessionId =
      typeof req.body?.sessionId === 'string' ? req.body.sessionId.slice(0, 100) : null;
    return sessionId ? `s:${sessionId}` : `ip:${req.ip}`;
  },
});
