import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@lifeplanner/database';
import { AppError, ErrorCode, fail } from '@lifeplanner/shared-utils';
import { logError } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(fail(ErrorCode.NOT_FOUND, `No route matches ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(fail(err.code, err.message, err.details));
    return;
  }

  if (err instanceof ZodError) {
    res
      .status(400)
      .json(fail(ErrorCode.VALIDATION_ERROR, 'Request validation failed', err.flatten()));
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res
        .status(409)
        .json(fail(ErrorCode.CONFLICT, 'A record with these values already exists', err.meta));
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json(fail(ErrorCode.NOT_FOUND, 'Resource not found'));
      return;
    }
    if (err.code === 'P2003') {
      res
        .status(400)
        .json(fail(ErrorCode.VALIDATION_ERROR, 'Referenced record does not exist', err.meta));
      return;
    }
  }

  // A 500 is the one case where the log has to be enough to debug from, so it
  // carries the route, the caller and the stack rather than just the message.
  logError(err, {
    requestId: (req as { id?: string | number }).id,
    method: req.method,
    url: req.originalUrl,
    userId: (req as { user?: { id: string } }).user?.id,
    adminId: (req as { admin?: { id: string } }).admin?.id,
    statusCode: 500,
  });
  res.status(500).json(fail(ErrorCode.INTERNAL_ERROR, 'Something went wrong'));
};

/** Wraps async handlers so rejected promises reach the error middleware. */
export const asyncHandler =
  <T extends RequestHandler>(handler: T): RequestHandler =>
  (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
