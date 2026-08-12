import { z } from 'zod';
import { dateString } from './common.js';

export const grantBoardShareSchema = z.object({
  viewerEmail: z.string().email().toLowerCase(),
  permission: z.enum(['PUBLIC_ONLY', 'FULL']).default('PUBLIC_ONLY'),
});

export const updateBoardShareSchema = z.object({
  permission: z.enum(['PUBLIC_ONLY', 'FULL']),
});

export const listBoardSharesQuerySchema = z.object({
  direction: z.enum(['granted', 'received']).default('granted'),
  status: z.enum(['ACTIVE', 'REVOKED']).optional(),
});

export const sharedBoardQuerySchema = z
  .object({ from: dateString, to: dateString })
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`', path: ['to'] });

export type GrantBoardShareInput = z.infer<typeof grantBoardShareSchema>;
export type UpdateBoardShareInput = z.infer<typeof updateBoardShareSchema>;
