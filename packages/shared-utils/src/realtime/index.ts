/**
 * Realtime contracts (Socket.IO, Redis-bridged). Shared verbatim by user-api and
 * admin-api so both sides agree on event names and payload shapes. Rooms are keyed
 * `conversation:{id}` and bridged across services via the Redis adapter.
 */

export const SOCKET_EVENTS = {
  // client → server
  CONVERSATION_JOIN: 'conversation:join',
  CONVERSATION_LEAVE: 'conversation:leave',
  MESSAGE_SEND: 'message:send',
  MESSAGE_READ: 'message:read',
  TYPING: 'typing',
  // server → room / client
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  CONVERSATION_UPDATED: 'conversation:updated',
  TYPING_RELAY: 'typing', // server re-emits typing into the room
  ERROR: 'error',
} as const;

export type MessageRoleWire = 'USER' | 'ADMIN' | 'SYSTEM';
export type ConversationStatusWire = 'OPEN' | 'ASSIGNED' | 'CLOSED';

export const conversationRoom = (conversationId: string): string =>
  `conversation:${conversationId}`;

// ───────────── Payloads ─────────────
export interface JoinLeavePayload {
  conversationId: string;
}

export interface MessageSendPayload {
  conversationId: string;
  content: string;
}

export interface MessageReadPayload {
  conversationId: string;
  upToMessageId: string;
}

export interface TypingPayload {
  conversationId: string;
  isTyping: boolean;
}

export interface MessageWire {
  id: string;
  conversationId: string;
  role: MessageRoleWire;
  adminId: string | null;
  content: string;
  readAt: string | null;
  editedAt: string | null;
  createdAt: string;
}

export interface MessageNewPayload {
  message: MessageWire;
}

export interface MessageUpdatedPayload {
  message: MessageWire;
}

export interface MessageDeletedPayload {
  conversationId: string;
  messageId: string;
}

export interface TypingRelayPayload {
  conversationId: string;
  from: MessageRoleWire;
  isTyping: boolean;
}

export interface ConversationUpdatedPayload {
  id: string;
  status: ConversationStatusWire;
  assignedAdminId: string | null;
}

export interface SocketErrorPayload {
  code: string;
  message: string;
}

// ───────────── Typed event maps for Socket.IO generics ─────────────
export interface ClientToServerEvents {
  'conversation:join': (p: JoinLeavePayload) => void;
  'conversation:leave': (p: JoinLeavePayload) => void;
  'message:send': (p: MessageSendPayload) => void;
  'message:read': (p: MessageReadPayload) => void;
  typing: (p: TypingPayload) => void;
}

export interface ServerToClientEvents {
  'message:new': (p: MessageNewPayload) => void;
  'message:updated': (p: MessageUpdatedPayload) => void;
  'message:deleted': (p: MessageDeletedPayload) => void;
  'conversation:updated': (p: ConversationUpdatedPayload) => void;
  typing: (p: TypingRelayPayload) => void;
  error: (p: SocketErrorPayload) => void;
}

export interface SocketData {
  /** Set at handshake from the verified token. One of these is present. */
  userId?: string;
  adminId?: string;
  adminRole?: 'SUPPORT' | 'SUPERADMIN';
}
