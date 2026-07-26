import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCode, type ErrorDetail } from '../errors/index.js';
import { failEnvelope } from './envelope.js';

interface MinimalLogger {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** Duck-types a Prisma known-request error without importing @prisma/client. */
function isPrismaKnownError(err: unknown): err is { code: string; meta?: unknown } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('P')
  );
}

function zodToDetails(err: ZodError): ErrorDetail[] {
  return err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

/**
 * Builds the central error middleware. Maps:
 *   - AppError            → its own httpStatus + code
 *   - ZodError            → 422 VALIDATION_ERROR (+ details)
 *   - Prisma P2002 unique → 409 CONFLICT
 *   - Prisma P2025        → 404 NOT_FOUND
 *   - everything else     → 500 INTERNAL (logged, generic message)
 */
export function makeErrorMiddleware(logger?: MinimalLogger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      return res
        .status(err.httpStatus)
        .json(failEnvelope(err.code, err.message, err.details));
    }

    if (err instanceof ZodError) {
      return res
        .status(422)
        .json(failEnvelope(ErrorCode.VALIDATION_ERROR, 'Validation failed', zodToDetails(err)));
    }

    if (isPrismaKnownError(err)) {
      if (err.code === 'P2002') {
        return res
          .status(409)
          .json(failEnvelope(ErrorCode.CONFLICT, 'A record with these values already exists'));
      }
      if (err.code === 'P2025') {
        return res
          .status(404)
          .json(failEnvelope(ErrorCode.NOT_FOUND, 'Record not found'));
      }
    }

    logger?.error({ err, path: req.path, method: req.method }, 'Unhandled error');
    return res
      .status(500)
      .json(failEnvelope(ErrorCode.INTERNAL, 'Internal server error'));
  };
}

/** 404 fallthrough for unmatched routes. Mount just before the error middleware. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(failEnvelope(ErrorCode.NOT_FOUND, 'Route not found'));
};
