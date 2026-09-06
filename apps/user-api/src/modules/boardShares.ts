import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  grantBoardShareSchema,
  idParamSchema,
  listBoardSharesQuerySchema,
  sendOk,
  sharedBoardQuerySchema,
  updateBoardShareSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { buildBoard } from '../lib/board.js';

export const boardSharesRouter = Router();

const shareInclude = {
  owner: { select: { id: true, name: true, email: true } },
  viewer: { select: { id: true, name: true, email: true } },
};

/**
 * Grant — owner-initiated, by the viewer's email. Each row is a one-way grant:
 * "bidirectional" sharing means two independently-created rows, each carrying
 * its own permission level. Re-inviting the same viewer updates the existing
 * row (unique [ownerId, viewerId]) rather than duplicating it.
 */
boardSharesRouter.post(
  '/',
  validate(grantBoardShareSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { viewerEmail, permission } = req.body;

    const viewer = await prisma.user.findFirst({
      where: { email: viewerEmail, deletedAt: null },
      select: { id: true, name: true, email: true },
    });
    if (!viewer) throw AppError.notFound('No account with that email');
    if (viewer.id === me.id) throw AppError.badRequest('You already have access to your own board');

    const boardShare = await prisma.boardShare.upsert({
      where: { ownerId_viewerId: { ownerId: me.id, viewerId: viewer.id } },
      update: { permission, status: 'ACTIVE' },
      create: { ownerId: me.id, viewerId: viewer.id, permission, status: 'ACTIVE' },
      include: shareInclude,
    });

    sendOk(res, { boardShare }, 201);
  }),
);

boardSharesRouter.get(
  '/',
  validate(listBoardSharesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { direction, status } = req.query as unknown as {
      direction: 'granted' | 'received';
      status?: 'ACTIVE' | 'REVOKED';
    };

    const boardShares = await prisma.boardShare.findMany({
      where: {
        ...(direction === 'granted' ? { ownerId: me.id } : { viewerId: me.id }),
        ...(status ? { status } : direction === 'received' ? { status: 'ACTIVE' } : {}),
      },
      include: shareInclude,
      orderBy: { updatedAt: 'desc' },
    });

    sendOk(res, { direction, boardShares });
  }),
);

boardSharesRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateBoardShareSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    // Owner only — a viewer cannot raise their own permission level.
    const owned = await prisma.boardShare.findFirst({
      where: { id: req.params.id, ownerId: me.id },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Board share not found');

    const boardShare = await prisma.boardShare.update({
      where: { id: owned.id },
      data: { permission: req.body.permission },
      include: shareInclude,
    });
    sendOk(res, { boardShare });
  }),
);

/** Revoke is a status flip, not a delete, so the grant history stays auditable. */
boardSharesRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.boardShare.findFirst({
      where: { id: req.params.id, ownerId: me.id },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Board share not found');

    const boardShare = await prisma.boardShare.update({
      where: { id: owned.id },
      data: { status: 'REVOKED' },
      include: shareInclude,
    });
    sendOk(res, { revoked: true, boardShare });
  }),
);

/**
 * GET /users/:id/board — mounted separately in app.ts. Reuses the calendar-range
 * logic with one filter layered on top: private activities are dropped unless
 * the granted permission is FULL.
 */
export const sharedBoardRouter = Router();

sharedBoardRouter.get(
  '/:id/board',
  validate(idParamSchema, 'params'),
  validate(sharedBoardQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const ownerId = req.params.id;
    const { from, to } = req.query as unknown as { from: string; to: string };

    if (ownerId === me.id) {
      const board = await buildBoard({ userId: me.id, from, to, includePrivate: true, includeDayNotes: true });
      sendOk(res, { owner: { id: me.id, name: me.name }, permission: 'FULL', ...board });
      return;
    }

    const share = await prisma.boardShare.findUnique({
      where: { ownerId_viewerId: { ownerId, viewerId: me.id } },
      include: { owner: { select: { id: true, name: true, status: true, deletedAt: true } } },
    });

    if (!share || share.status !== 'ACTIVE' || share.owner.deletedAt) {
      throw AppError.forbidden(
        'You do not have access to this board',
        ErrorCode.SHARE_NOT_GRANTED,
      );
    }

    const board = await buildBoard({
      userId: ownerId,
      from,
      to,
      includePrivate: share.permission === 'FULL',
    });

    sendOk(res, {
      owner: { id: share.owner.id, name: share.owner.name },
      permission: share.permission,
      ...board,
    });
  }),
);
