import { z } from 'zod';

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

export const adminInboxQuerySchema = z.object({
  status: z.enum(['OPEN', 'CLAIMED', 'CLOSED']).optional(),
  type: z.enum(['LIFE_COACH', 'FITNESS', 'SUPPORT']).optional(),
  /**
   * 'any' is restricted to MANAGER/SUPERADMIN by the route — a coach may only
   * ever list their own queue plus unassigned work in the types they staff.
   */
  assigned: z.enum(['me', 'unassigned', 'any']).default('me'),
  adminId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
