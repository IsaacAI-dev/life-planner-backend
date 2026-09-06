import { z } from 'zod';

export const conversationTypeEnum = z.enum(['LIFE_COACH', 'FITNESS', 'SUPPORT']);

export const listConversationsV3QuerySchema = z.object({
  type: conversationTypeEnum.optional(),
  status: z.enum(['OPEN', 'CLAIMED', 'CLOSED']).optional(),
});

export const openConversationSchema = z.object({
  type: conversationTypeEnum,
  message: z.string().trim().min(1).max(4000).optional(),
});

export const sendMessageV3Schema = z.object({
  content: z.string().trim().min(1).max(4000),
  /** Quote reply — must belong to the same conversation. */
  replyToId: z.string().min(1).optional(),
});

export const editMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

export const reactToMessageSchema = z.object({
  /** A single emoji grapheme; length is generous for ZWJ sequences. */
  emoji: z.string().trim().min(1).max(16),
});

/** P-10 — voice note upload. Duration and size ceilings come from the env. */
export const voiceNoteSchema = z.object({
  audioBase64: z.string().min(32),
  mimeType: z.string().trim().min(3).max(80),
  durationSeconds: z.number().int().min(1).max(3600),
  replyToId: z.string().min(1).optional(),
});

export const messageHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().min(1).optional(),
  /** Manager/superadmin only — includes soft-deleted rows and edit history. */
  includeDeleted: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

/** Admin-authored in-chat suggestion the user can accept in one tap. */
export const sendRecommendationSchema = z
  .object({
    kind: z.enum(['ACTIVITY', 'GOAL']),
    message: z.string().trim().max(1000).optional(),
    payload: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
      endTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      categoryName: z.string().trim().max(60).optional(),
      windowStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      windowEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      targetCount: z.number().int().min(1).max(100).optional(),
    }),
  })
  .refine((v) => v.kind !== 'ACTIVITY' || Boolean(v.payload.date || v.payload.windowStart), {
    message: 'An ACTIVITY recommendation needs either a date or a window',
  });

export const respondRecommendationSchema = z.object({
  action: z.enum(['ACCEPT', 'DISMISS']),
});

/** Weekly feedback form Support sends into the chat. */
export const sendFeedbackFormSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  message: z.string().trim().max(500).optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const submitFeedbackSchema = z
  .object({
    platformRating: z.number().int().min(1).max(5).optional(),
    lifeCoachRating: z.number().int().min(1).max(5).optional(),
    fitnessRating: z.number().int().min(1).max(5).optional(),
    supportRating: z.number().int().min(1).max(5).optional(),
    comment: z.string().trim().max(2000).optional(),
  })
  .refine(
    (v) =>
      v.platformRating !== undefined ||
      v.lifeCoachRating !== undefined ||
      v.fitnessRating !== undefined ||
      v.supportRating !== undefined,
    { message: 'Provide at least one rating' },
  );

/** Manager/superadmin reassignment. */
export const reassignConversationSchema = z.object({
  toAdminId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});

export const reassignCoachSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['LIFE_COACH', 'FITNESS']),
  toAdminId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
  /** Move the existing conversation to the new coach as well. */
  moveConversation: z.boolean().default(true),
});

export type SendRecommendationInput = z.infer<typeof sendRecommendationSchema>;
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;
