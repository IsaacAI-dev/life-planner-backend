import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import { AppError, createTagSchema, idParamSchema, sendOk, updateTagSchema } from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const tagsRouter = Router();

tagsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const tags = await prisma.tag.findMany({
      where: { userId: me.id },
      orderBy: { name: 'asc' },
      include: { _count: { select: { activities: true } } },
    });
    sendOk(res, { tags });
  }),
);

tagsRouter.post(
  '/',
  validate(createTagSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const tag = await prisma.tag.upsert({
      where: { userId_name: { userId: me.id, name: req.body.name } },
      update: { color: req.body.color },
      create: { ...req.body, userId: me.id },
    });
    sendOk(res, { tag }, 201);
  }),
);

tagsRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateTagSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.tag.findFirst({ where: { id: req.params.id, userId: me.id } });
    if (!owned) throw AppError.notFound('Tag not found');
    const tag = await prisma.tag.update({ where: { id: owned.id }, data: req.body });
    sendOk(res, { tag });
  }),
);

tagsRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.tag.findFirst({ where: { id: req.params.id, userId: me.id } });
    if (!owned) throw AppError.notFound('Tag not found');
    await prisma.tag.delete({ where: { id: owned.id } });
    sendOk(res, { deleted: true });
  }),
);
