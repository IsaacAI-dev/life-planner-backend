import type { RequestHandler } from 'express';
import type { ZodSchema } from 'zod';
import { ZodError } from 'zod';
import { AppError, ErrorCode } from '@lifeplanner/shared-utils';

type Source = 'body' | 'query' | 'params';

/**
 * Parses one request segment with a Zod schema and replaces it with the parsed
 * (defaulted, coerced) value. Validation lives at the API boundary — see the
 * Addendum's note on flexible-vs-dated tasks being enforced here, not in the DB.
 */
export const validate =
  (schema: ZodSchema, source: Source = 'body'): RequestHandler =>
  (req, _res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      if (source === 'query') {
        // req.query is a getter-only property on Express 5-style requests.
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      } else {
        req[source] = parsed as never;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(
          AppError.badRequest(
            'Request validation failed',
            ErrorCode.VALIDATION_ERROR,
            err.flatten(),
          ),
        );
        return;
      }
      next(err);
    }
  };
