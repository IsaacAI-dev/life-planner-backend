import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler,
  assignConversationSchema,
  created,
  editMessageSchema,
  id,
  idParam,
  ok,
  sendMessageSchema,
  validate,
} from '@life-planner/shared-utils';
import { currentAdmin, requireAdmin } from '../../middleware/auth.js';
import * as svc from './conversations.service.js';

/** Params for nested message routes: /conversations/:cid/messages/:mid */
const messageParams = z.object({ cid: id, mid: id });

export const conversationsRouter = Router();
conversationsRouter.use(requireAdmin);

conversationsRouter.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, await svc.getConversation(req.params.id));
}));

conversationsRouter.get('/:id/messages', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const { messages } = await svc.getConversation(req.params.id);
  ok(res, { messages });
}));

conversationsRouter.post('/:id/claim', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, { conversation: await svc.claim(currentAdmin(req).id, req.params.id) });
}));

conversationsRouter.post(
  '/:id/assign',
  validate({ params: idParam, body: assignConversationSchema }),
  asyncHandler(async (req, res) => {
    ok(res, { conversation: await svc.assign(req.params.id, req.body.adminId) });
  }),
);

conversationsRouter.post(
  '/:id/messages',
  validate({ params: idParam, body: sendMessageSchema }),
  asyncHandler(async (req, res) => {
    created(res, { message: await svc.reply(currentAdmin(req), req.params.id, req.body) });
  }),
);

conversationsRouter.patch(
  '/:cid/messages/:mid',
  validate({ params: messageParams, body: editMessageSchema }),
  asyncHandler(async (req, res) => {
    const { cid, mid } = req.params as { cid: string; mid: string };
    ok(res, { message: await svc.editMessage(currentAdmin(req).id, cid, mid, req.body) });
  }),
);

conversationsRouter.delete(
  '/:cid/messages/:mid',
  validate({ params: messageParams }),
  asyncHandler(async (req, res) => {
    const { cid, mid } = req.params as { cid: string; mid: string };
    ok(res, await svc.deleteMessage(currentAdmin(req).id, cid, mid));
  }),
);

conversationsRouter.post('/:id/close', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, { conversation: await svc.close(req.params.id) });
}));

conversationsRouter.post('/:id/reopen', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, { conversation: await svc.reopen(req.params.id) });
}));
