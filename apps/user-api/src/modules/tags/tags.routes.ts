import { Router } from 'express';
import { asyncHandler, created, createTagSchema, idParam, ok, validate } from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './tags.service.js';

export const tagsRouter = Router();
tagsRouter.use(requireAuth);

tagsRouter.get('/', asyncHandler(async (req, res) => {
  ok(res, { tags: await svc.listTags(currentUserId(req)) });
}));

tagsRouter.post('/', validate({ body: createTagSchema }), asyncHandler(async (req, res) => {
  created(res, { tag: await svc.createTag(currentUserId(req), req.body) });
}));

tagsRouter.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  await svc.deleteTag(currentUserId(req), req.params.id);
  ok(res, { deleted: true });
}));
