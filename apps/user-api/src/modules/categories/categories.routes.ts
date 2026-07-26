import { Router } from 'express';
import {
  asyncHandler,
  created,
  createCategorySchema,
  idParam,
  ok,
  updateCategorySchema,
  validate,
} from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './categories.service.js';

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

categoriesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    ok(res, { categories: await svc.listCategories(currentUserId(req)) });
  }),
);

categoriesRouter.post(
  '/',
  validate({ body: createCategorySchema }),
  asyncHandler(async (req, res) => {
    created(res, { category: await svc.createCategory(currentUserId(req), req.body) });
  }),
);

categoriesRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateCategorySchema }),
  asyncHandler(async (req, res) => {
    const category = await svc.updateCategory(currentUserId(req), req.params.id, req.body);
    ok(res, { category });
  }),
);

categoriesRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteCategory(currentUserId(req), req.params.id);
    ok(res, { deleted: true });
  }),
);
