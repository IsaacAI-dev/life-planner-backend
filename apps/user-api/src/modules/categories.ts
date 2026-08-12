import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  createCategorySchema,
  idParamSchema,
  sendOk,
  updateCategorySchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const categoriesRouter = Router();

categoriesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const categories = await prisma.category.findMany({
      where: { userId: me.id, deletedAt: null },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { activities: true } } },
    });
    sendOk(res, { categories });
  }),
);

categoriesRouter.post(
  '/',
  validate(createCategorySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await prisma.category.findFirst({
      where: { userId: me.id, name: req.body.name, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw AppError.conflict('You already have a category with that name');

    const category = await prisma.category.create({ data: { ...req.body, userId: me.id } });
    sendOk(res, { category }, 201);
  }),
);

categoriesRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateCategorySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.category.findFirst({
      where: { id: req.params.id, userId: me.id, deletedAt: null },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Category not found');

    const category = await prisma.category.update({ where: { id: owned.id }, data: req.body });
    sendOk(res, { category });
  }),
);

categoriesRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.category.findFirst({
      where: { id: req.params.id, userId: me.id, deletedAt: null },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Category not found');

    // Soft delete; activities keep working with categoryId set to null.
    await prisma.$transaction([
      prisma.activity.updateMany({ where: { categoryId: owned.id }, data: { categoryId: null } }),
      prisma.category.update({ where: { id: owned.id }, data: { deletedAt: new Date() } }),
    ]);
    sendOk(res, { deleted: true });
  }),
);
