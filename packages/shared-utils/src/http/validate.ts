import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';

export interface ValidationTargets {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and COERCES request parts in place using the provided Zod schemas.
 * Parsed (typed/transformed) values replace req.body / req.query / req.params,
 * so downstream handlers receive clean data. ZodErrors propagate to the central
 * error middleware (→ 422).
 */
export function validate(targets: ValidationTargets): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (targets.body) req.body = targets.body.parse(req.body);
      if (targets.query) {
        const parsed = targets.query.parse(req.query);
        // req.query is a getter-only on some Express versions; assign defensively.
        Object.defineProperty(req, 'query', { value: parsed, configurable: true });
      }
      if (targets.params) req.params = targets.params.parse(req.params) as typeof req.params;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Wraps an async route handler so rejected promises reach the error middleware. */
export function asyncHandler<
  P = Request['params'],
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Request['query'],
>(
  fn: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => Promise<unknown>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export { z };
