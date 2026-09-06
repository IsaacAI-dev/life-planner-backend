import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured JSON logs, one object per line, straight to stdout in production
 * so whatever collects them (Docker, systemd, a log shipper) does the shipping.
 *
 * Redaction is the important part here. Pino logs whole request objects, which
 * means bearer tokens, cookies and password fields end up on disk and in every
 * downstream log tool unless they are removed at the source. `remove: true`
 * drops the keys entirely rather than printing [Redacted], so a token cannot be
 * reconstructed from a log line.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'admin-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.tokenHash',
      '*.purchaseToken',
      '*.signedPayload',
      '*.imageBase64',
      '*.audioBase64',
      'body.password',
      'body.currentPassword',
      'body.newPassword',
    ],
    remove: true,
  },
  // ISO timestamps rather than epoch millis: these get read by people.
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: env.isProd ? undefined : { target: 'pino/file', options: { destination: 1 } },
});

/**
 * Attaches the context you actually want when reading an error after the fact:
 * which route, which user, which request, and the stack.
 */
export const logError = (
  err: unknown,
  context: {
    requestId?: string | number;
    method?: string;
    url?: string;
    userId?: string;
    adminId?: string;
    statusCode?: number;
  },
) => {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(
    {
      ...context,
      err: { type: error.name, message: error.message, stack: error.stack },
    },
    'Unhandled error',
  );
};
