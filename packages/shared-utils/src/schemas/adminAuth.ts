import { z } from 'zod';

export const adminLoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
});

export const adminRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const createAdminSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['SUPPORT', 'SUPERADMIN']).default('SUPPORT'),
});

export const assignConversationSchema = z.object({
  adminId: z.string().cuid(),
});

export const inboxQuerySchema = z.object({
  status: z.enum(['OPEN', 'ASSIGNED', 'CLOSED']).optional(),
  channel: z.enum(['GENERAL', 'FITNESS_COACH']).optional(),
  assigned: z.literal('me').optional(),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type CreateAdminInput = z.infer<typeof createAdminSchema>;
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
