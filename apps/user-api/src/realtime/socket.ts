import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { prisma } from '@lifeplanner/database';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createRedis } from '../lib/redis.js';
import { verifyAccessToken } from '../lib/tokens.js';

let io: Server | null = null;

const userRoom = (userId: string) => `user:${userId}`;
const conversationRoom = (conversationId: string) => `conversation:${conversationId}`;

export function initSocketServer(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    path: '/socket.io',
  });

  // Redis adapter so multiple user-api instances broadcast to each other.
  const pubClient = createRedis('socket-pub');
  const subClient = createRedis('socket-sub');
  io.adapter(createAdapter(pubClient, subClient));

  io.use((socket, next) => {
    void (async () => {
      try {
        const token =
          (socket.handshake.auth?.token as string | undefined) ??
          socket.handshake.headers.authorization?.replace('Bearer ', '');
        if (!token) throw new Error('Missing token');

        const payload = verifyAccessToken(token);
        const user = await prisma.user.findUnique({
          where: { id: payload.sub },
          select: { id: true, status: true, deletedAt: true },
        });

        /**
         * Addendum 2 §21 — a banned user's refresh tokens are revoked, so their
         * next handshake fails once the current access token expires (<=15 min).
         * Re-checking status here closes that window for new connections.
         */
        if (!user || user.deletedAt || user.status !== 'ACTIVE') {
          throw new Error('Account is not active');
        }

        socket.data.userId = user.id;
        next();
      } catch (err) {
        next(err instanceof Error ? err : new Error('Unauthorized'));
      }
    })();
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    void socket.join(userRoom(userId));
    logger.debug({ userId, socketId: socket.id }, 'Socket connected');

    socket.on('conversation:join', (conversationId: string) => {
      void (async () => {
        const conversation = await prisma.conversation.findFirst({
          where: { id: conversationId, userId },
          select: { id: true },
        });
        if (!conversation) {
          socket.emit('error:conversation', { message: 'Conversation not found' });
          return;
        }
        await socket.join(conversationRoom(conversationId));
        socket.emit('conversation:joined', { conversationId });
      })();
    });

    socket.on('conversation:leave', (conversationId: string) => {
      void socket.leave(conversationRoom(conversationId));
    });

    socket.on('typing', (payload: { conversationId: string; isTyping: boolean }) => {
      if (!payload?.conversationId) return;
      socket.to(conversationRoom(payload.conversationId)).emit('typing', {
        conversationId: payload.conversationId,
        userId,
        isTyping: Boolean(payload.isTyping),
      });
    });

    socket.on('disconnect', () => {
      logger.debug({ userId, socketId: socket.id }, 'Socket disconnected');
    });
  });

  return io;
}

/**
 * Messages are written by the REST handlers and only broadcast here — the
 * socket layer never persists, which is what keeps a message from being stored
 * twice when a client is connected on both paths.
 */
export const emitToConversation = (conversationId: string, event: string, payload: unknown) => {
  io?.to(conversationRoom(conversationId)).emit(event, payload);
};

export const emitToUser = (userId: string, event: string, payload: unknown) => {
  io?.to(userRoom(userId)).emit(event, payload);
};

/** Optional immediate-kick path referenced by the ban handler (Addendum 2 §21). */
export const disconnectUserSockets = async (userId: string) => {
  if (!io) return;
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  for (const socket of sockets) socket.disconnect(true);
};

export const getIo = () => io;
