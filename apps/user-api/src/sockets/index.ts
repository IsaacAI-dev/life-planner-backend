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
import { chatService } from '../modules/chat/chat.routes.js';

/** Confirms a conversation belongs to the connecting user before room access. */
async function userOwnsConversation(userId: string, conversationId: string): Promise<boolean> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, userId, deletedAt: null },
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

  // Cross-service room bridging (user-api ⇄ admin-api) via Redis pub/sub.
  const { pub, sub } = makePubSubPair();
  await Promise.all([pub.connect(), sub.connect()]);
  io.adapter(createAdapter(pub, sub));

  // Handshake auth: verify the user access token, pin userId onto the socket.
  io.use((socket, next) => {
    try {
      const raw =
        (socket.handshake.auth?.token as string | undefined) ??
        (typeof socket.handshake.headers.authorization === 'string'
          ? socket.handshake.headers.authorization.replace(/^Bearer\s+/i, '')
          : undefined);
      if (!raw) return next(new Error('unauthorized'));
      const claims = jwtService.verifyUserAccess(raw);
      socket.data.userId = claims.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId!;
    logger.debug({ userId, socketId: socket.id }, 'socket connected');

    socket.on(SOCKET_EVENTS.CONVERSATION_JOIN, async ({ conversationId }) => {
      if (await userOwnsConversation(userId, conversationId)) {
        await socket.join(conversationRoom(conversationId));
      } else {
        socket.emit(SOCKET_EVENTS.ERROR, { code: 'FORBIDDEN', message: 'Not your conversation' });
      }
    });

    socket.on(SOCKET_EVENTS.CONVERSATION_LEAVE, async ({ conversationId }) => {
      await socket.leave(conversationRoom(conversationId));
    });

    socket.on(SOCKET_EVENTS.MESSAGE_SEND, async ({ conversationId, content }) => {
      try {
        // Service persists and emits message:new into the room (incl. admin side).
        await chatService.sendMessage(userId, conversationId, { content });
      } catch (err) {
        logger.warn({ err, userId, conversationId }, 'socket message:send failed');
        socket.emit(SOCKET_EVENTS.ERROR, { code: 'SEND_FAILED', message: 'Could not send message' });
      }
    });

    socket.on(SOCKET_EVENTS.MESSAGE_READ, async ({ conversationId, upToMessageId }) => {
      try {
        await chatService.markRead(userId, conversationId, upToMessageId);
      } catch (err) {
        logger.warn({ err, userId, conversationId }, 'socket message:read failed');
      }
    });

    socket.on(SOCKET_EVENTS.TYPING, ({ conversationId, isTyping }) => {
      socket.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.TYPING_RELAY, {
        conversationId,
        from: 'USER',
        isTyping,
      });
    });

    socket.on('disconnect', () => {
      logger.debug({ userId, socketId: socket.id }, 'socket disconnected');
    });
  });

  setIo(io);
  return io;
}
