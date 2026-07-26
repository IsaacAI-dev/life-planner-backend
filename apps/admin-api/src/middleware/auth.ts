import type { NextFunction, Request, Response } from 'express';
import { AppError, type AdminRoleClaim } from '@life-planner/shared-utils';
import { jwtService } from '../jwt.js';

/** Verifies the admin Bearer access token and attaches req.admin. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  const claims = jwtService.verifyAdminAccess(token);
  req.admin = { id: claims.sub, role: claims.role };
  next();
}

/** Gate for SUPERADMIN-only routes (admin user management). */
export function requireSuperadmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.admin) throw AppError.unauthorized();
  if (req.admin.role !== 'SUPERADMIN') {
    throw AppError.forbidden('Requires SUPERADMIN role');
  }
  next();
}

export function currentAdmin(req: Request): { id: string; role: AdminRoleClaim } {
  if (!req.admin) throw AppError.unauthorized();
  return req.admin;
}
