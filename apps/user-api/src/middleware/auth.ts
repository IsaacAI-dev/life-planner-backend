import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@life-planner/shared-utils';
import { jwtService } from '../jwt.js';

/**
 * Verifies the Bearer access token and attaches req.user = { id }.
 * Throws 401 on any failure; the central error middleware formats it.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  const claims = jwtService.verifyUserAccess(token);
  req.user = { id: claims.sub };
  next();
}

/** Convenience accessor that asserts req.user is present (after requireAuth). */
export function currentUserId(req: Request): string {
  if (!req.user) throw AppError.unauthorized();
  return req.user.id;
}
