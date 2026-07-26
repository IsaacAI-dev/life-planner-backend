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

let io: AppServer | null = null;

export function setIo(server: AppServer): void {
  io = server;
}

export function getIo(): AppServer | null {
  return io;
}

/** Emits into the shared `conversation:{id}` room; reaches user-api clients via Redis. */
export function emitMessageNew(conversationId: string, payload: MessageNewPayload): void {
  io?.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_NEW, payload);
}

export function emitConversationUpdated(payload: ConversationUpdatedPayload): void {
  io?.to(conversationRoom(payload.id)).emit(SOCKET_EVENTS.CONVERSATION_UPDATED, payload);
}

export function emitMessageUpdated(conversationId: string, payload: MessageUpdatedPayload): void {
  io?.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_UPDATED, payload);
}

export function emitMessageDeleted(conversationId: string, payload: MessageDeletedPayload): void {
  io?.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_DELETED, payload);
}
