import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  adminLoginSchema,
  createAdminV3Schema,
  adminListQuerySchema,
  adminProfileUpdateSchema,
  paginate,
  logoutSchema,
  refreshSchema,
  sendOk,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { adminAuthLimiter } from '../middleware/rateLimit.js';
import { currentAdmin, requireAdmin, requireOversight, requireSuperadmin } from '../middleware/auth.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  issueAdminTokens,
  revokeAdminRefreshToken,
  rotateAdminRefreshToken,
} from '../lib/tokens.js';

export const adminAuthRouter = Router();

const publicAdmin = (admin: {
  id: string;
  email: string;
  name: string;
  roles: string[];
  isAvailable?: boolean;
  maxClients?: number;
  avatarUrl?: string | null;
  createdAt?: Date;
}) => ({
  id: admin.id,
  email: admin.email,
  name: admin.name,
  roles: admin.roles,
  isAvailable: admin.isAvailable,
  maxClients: admin.maxClients,
  avatarUrl: admin.avatarUrl ?? null,
  createdAt: admin.createdAt,
});

adminAuthRouter.post(
  '/login',
  adminAuthLimiter,
  validate(adminLoginSchema),
  asyncHandler(async (req, res) => {
    const admin = await prisma.admin.findUnique({ where: { email: req.body.email } });
    if (!admin || admin.deletedAt || !(await verifyPassword(admin.passwordHash, req.body.password))) {
      throw AppError.unauthorized('Email or password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }
    if (admin.status === 'DISABLED') {
      throw AppError.forbidden('This admin account has been disabled. Speak to a Super Admin.');
    }

    const tokens = await issueAdminTokens(admin.id, admin.email, admin.roles);
    sendOk(res, { admin: publicAdmin(admin), tokens });
  }),
);

adminAuthRouter.post(
  '/refresh',
  adminAuthLimiter,
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { admin, tokens } = await rotateAdminRefreshToken(req.body.refreshToken);
    sendOk(res, { admin: publicAdmin(admin), tokens });
  }),
);

adminAuthRouter.post(
  '/logout',
  validate(logoutSchema),
  asyncHandler(async (req, res) => {
    if (req.body.refreshToken) await revokeAdminRefreshToken(req.body.refreshToken);
    sendOk(res, { loggedOut: true });
  }),
);

adminAuthRouter.get(
  '/me',
  requireAdmin,
  asyncHandler(async (req, res) => {
    sendOk(res, { admin: currentAdmin(req) });
  }),
);

export const adminsRouter = Router();

adminsRouter.get(
  '/',
  requireOversight,
  validate(adminListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { q, role, status, page, pageSize } = req.query as unknown as {
      q?: string;
      role?: string;
      status?: string;
      page: number;
      pageSize: number;
    };

    const where = {
      deletedAt: null,
      ...(status ? { status: status as never } : {}),
      ...(role ? { roles: { has: role as never } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const total = await prisma.admin.count({ where });
    const admins = await prisma.admin.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        roles: true,
        status: true,
        phone: true,
        country: true,
        isAvailable: true,
        maxClients: true,
        avatarUrl: true,
        lastActiveAt: true,
        createdAt: true,
        _count: { select: { coachAssignments: { where: { status: 'ACTIVE' } } } },
      },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    sendOk(
      res,
      paginate(
        admins.map((a) => ({
          ...a,
          activeClients: a._count.coachAssignments,
          _count: undefined,
        })),
        page,
        pageSize,
        total,
      ),
    );
  }),
);

adminsRouter.post(
  '/',
  requireSuperadmin,
  validate(createAdminV3Schema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.admin.findUnique({
      where: { email: req.body.email },
      select: { id: true },
    });
    if (existing) throw AppError.conflict('That email is already registered', ErrorCode.EMAIL_TAKEN);

    const admin = await prisma.admin.create({
      data: {
        email: req.body.email,
        name: req.body.name,
        roles: req.body.roles,
        maxClients: req.body.maxClients,
        bio: req.body.bio ?? null,
        passwordHash: await hashPassword(req.body.password),
      },
      select: { id: true, email: true, name: true, roles: true, maxClients: true, createdAt: true },
    });
    sendOk(res, { admin }, 201);
  }),
);

adminsRouter.delete(
  '/:id',
  requireSuperadmin,
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    if (req.params.id === me.id) throw AppError.badRequest('You cannot deactivate your own account');

    await prisma.admin.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    sendOk(res, { deactivated: true });
  }),
);

/** Role, availability and capacity changes. Superadmin only. */
adminsRouter.patch(
  '/:id',
  requireSuperadmin,
  validate(adminProfileUpdateSchema),
  asyncHandler(async (req, res) => {
    const admin = await prisma.admin.update({
      where: { id: req.params.id },
      data: req.body,
      select: {
        id: true,
        email: true,
        name: true,
        roles: true,
        status: true,
        phone: true,
        country: true,
        isAvailable: true,
        maxClients: true,
        avatarUrl: true,
        lastActiveAt: true,
      },
    });
    sendOk(res, { admin });
  }),
);

/** Coaches available to take on a given role, with their current load. */
adminsRouter.get(
  '/coaches/:role',
  requireOversight,
  asyncHandler(async (req, res) => {
    const role = req.params.role === 'FITNESS' ? 'FITNESS_ADMIN' : 'LIFE_COACH_ADMIN';
    const coachRole = req.params.role === 'FITNESS' ? 'FITNESS' : 'LIFE_COACH';

    const coaches = await prisma.admin.findMany({
      where: { deletedAt: null, roles: { has: role } },
      select: {
        id: true,
        name: true,
        email: true,
        isAvailable: true,
        maxClients: true,
        _count: { select: { coachAssignments: { where: { status: 'ACTIVE', role: coachRole } } } },
      },
      orderBy: { name: 'asc' },
    });

    sendOk(res, {
      role: coachRole,
      coaches: coaches.map((c) => ({
        ...c,
        activeClients: c._count.coachAssignments,
        hasCapacity: c._count.coachAssignments < c.maxClients && c.isAvailable,
        _count: undefined,
      })),
    });
  }),
);
