import { z } from 'zod';

export const chatChannel = z.enum(['GENERAL', 'FITNESS_COACH']);

export const createConversationSchema = z.object({
  channel: chatChannel,
  title: z.string().trim().min(1).max(200).optional(),
});

export const listConversationsQuerySchema = z.object({
  channel: chatChannel.optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

/** Editing reuses the send-message shape (content only). */
export const editMessageSchema = sendMessageSchema;

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
