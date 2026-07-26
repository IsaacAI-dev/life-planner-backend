import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import {
  conversationRoom,
  SOCKET_EVENTS,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';
import { corsOrigins } from '../env.js';
import { logger } from '../logger.js';
import { jwtService } from '../jwt.js';
import { makePubSubPair } from '../redis.js';
import { setIo, type AppServer } from '../realtime.js';
import * as conversations from '../modules/conversations/conversations.service.js';

async function conversationExists(conversationId: string): Promise<boolean> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, deletedAt: null },
    select: { id: true },
  });
  return Boolean(convo);
}

export async function attachSockets(httpServer: HttpServer): Promise<AppServer> {
  const io: AppServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    cors: { origin: corsOrigins, credentials: true },
  });

  // Same Redis adapter + same room keys as user-api → cross-service delivery.
  const { pub, sub } = makePubSubPair();
  await Promise.all([pub.connect(), sub.connect()]);
  io.adapter(createAdapter(pub, sub));

  io.use((socket, next) => {
    try {
      const raw =
        (socket.handshake.auth?.token as string | undefined) ??
        (typeof socket.handshake.headers.authorization === 'string'
          ? socket.handshake.headers.authorization.replace(/^Bearer\s+/i, '')
          : undefined);
      if (!raw) return next(new Error('unauthorized'));
      const claims = jwtService.verifyAdminAccess(raw);
      socket.data.adminId = claims.sub;
      socket.data.adminRole = claims.role;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const adminId = socket.data.adminId!;
    const adminRole = socket.data.adminRole!;
    logger.debug({ adminId, socketId: socket.id }, 'admin socket connected');

    socket.on(SOCKET_EVENTS.CONVERSATION_JOIN, async ({ conversationId }) => {
      if (await conversationExists(conversationId)) {
        await socket.join(conversationRoom(conversationId));
      } else {
        socket.emit(SOCKET_EVENTS.ERROR, { code: 'NOT_FOUND', message: 'Conversation not found' });
      }
    });

    socket.on(SOCKET_EVENTS.CONVERSATION_LEAVE, async ({ conversationId }) => {
      await socket.leave(conversationRoom(conversationId));
    });

    socket.on(SOCKET_EVENTS.MESSAGE_SEND, async ({ conversationId, content }) => {
      try {
        // Persists as ADMIN + emits message:new into the room (incl. user side).
        await conversations.reply({ id: adminId, role: adminRole }, conversationId, { content });
      } catch (err) {
        logger.warn({ err, adminId, conversationId }, 'admin socket message:send failed');
        socket.emit(SOCKET_EVENTS.ERROR, { code: 'SEND_FAILED', message: 'Could not send message' });
      }
    });

    socket.on(SOCKET_EVENTS.MESSAGE_READ, async ({ conversationId, upToMessageId }) => {
      try {
        const target = await prisma.message.findFirst({
          where: { id: upToMessageId, conversationId },
          select: { createdAt: true },
        });
        if (!target) return;
        await prisma.message.updateMany({
          where: {
            conversationId,
            role: 'USER',
            readAt: null,
            createdAt: { lte: target.createdAt },
          },
          data: { readAt: new Date() },
        });
      } catch (err) {
        logger.warn({ err, adminId, conversationId }, 'admin socket message:read failed');
      }
    });

    socket.on(SOCKET_EVENTS.TYPING, ({ conversationId, isTyping }) => {
      socket.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.TYPING_RELAY, {
        conversationId,
        from: 'ADMIN',
        isTyping,
      });
    });

    socket.on('disconnect', () => {
      logger.debug({ adminId, socketId: socket.id }, 'admin socket disconnected');
    });
  });

  setIo(io);
  return io;
}
