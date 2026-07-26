import type { Server } from 'socket.io';
import {
  conversationRoom,
  SOCKET_EVENTS,
  type ClientToServerEvents,
  type ConversationUpdatedPayload,
  type MessageDeletedPayload,
  type MessageNewPayload,
  type MessageUpdatedPayload,
  type ServerToClientEvents,
  type SocketData,
} from '@life-planner/shared-utils';

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Module-level Socket.IO handle so REST handlers (e.g. chat.sendMessage) can
 * push realtime events without importing server.ts (avoids a cycle). Set once
 * during boot. Emits go through the Redis adapter, so user-api and admin-api
 * both deliver into the same `conversation:{id}` rooms.
 */
let io: AppServer | null = null;

export function setIo(server: AppServer): void {
  io = server;
}

export function getIo(): AppServer | null {
  return io;
}

export function emitMessageNew(conversationId: string, payload: MessageNewPayload): void {
  io?.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_NEW, payload);
}

export function emitMessageUpdated(conversationId: string, payload: MessageUpdatedPayload): void {
  io?.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_UPDATED, payload);
}

export function emitMessageDeleted(conversationId: string, payload: MessageDeletedPayload): void {
  io?.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_DELETED, payload);
}

export function emitConversationUpdated(payload: ConversationUpdatedPayload): void {
  io?.to(conversationRoom(payload.id)).emit(SOCKET_EVENTS.CONVERSATION_UPDATED, payload);
}
