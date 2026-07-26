import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler,
  created,
  createConversationSchema,
  editMessageSchema,
  id,
  idParam,
  listConversationsQuerySchema,
  ok,
  sendMessageSchema,
  validate,
} from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import { requireActiveUser } from '../../middleware/requireActiveUser.js';
import { messageLimiter } from '../../middleware/rateLimit.js';
import * as svc from './chat.service.js';

/** Params for nested message routes: /conversations/:cid/messages/:mid */
const messageParams = z.object({ cid: id, mid: id });

export const chatRouter = Router();
chatRouter.use(requireAuth);
chatRouter.use(requireActiveUser);

chatRouter.get('/conversations', validate({ query: listConversationsQuerySchema }), asyncHandler(async (req, res) => {
  const { channel } = req.query as { channel?: 'GENERAL' | 'FITNESS_COACH' };
  ok(res, { conversations: await svc.listConversations(currentUserId(req), channel) });
}));

chatRouter.post('/conversations', validate({ body: createConversationSchema }), asyncHandler(async (req, res) => {
  created(res, { conversation: await svc.createConversation(currentUserId(req), req.body) });
}));

chatRouter.get('/conversations/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, await svc.getConversation(currentUserId(req), req.params.id));
}));

chatRouter.delete('/conversations/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  ok(res, await svc.deleteConversation(currentUserId(req), req.params.id));
}));

chatRouter.post(
  '/conversations/:id/messages',
  messageLimiter,
  validate({ params: idParam, body: sendMessageSchema }),
  asyncHandler(async (req, res) => {
    created(res, { message: await svc.sendMessage(currentUserId(req), req.params.id, req.body) });
  }),
);

chatRouter.patch(
  '/conversations/:cid/messages/:mid',
  validate({ params: messageParams, body: editMessageSchema }),
  asyncHandler(async (req, res) => {
    const { cid, mid } = req.params as { cid: string; mid: string };
    ok(res, { message: await svc.editMessage(currentUserId(req), cid, mid, req.body) });
  }),
);

chatRouter.delete(
  '/conversations/:cid/messages/:mid',
  validate({ params: messageParams }),
  asyncHandler(async (req, res) => {
    const { cid, mid } = req.params as { cid: string; mid: string };
    ok(res, await svc.deleteMessage(currentUserId(req), cid, mid));
  }),
);

export { svc as chatService };
