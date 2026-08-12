import { z } from 'zod';

/**
 * Every admin list is paginated. The console's tables all share this shape, so
 * a table component can be written once.
 */
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
};

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// --- Users ------------------------------------------------------------------

export const adminUserQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED']).optional(),
  /// FREE | PRO | EXPIRED — the console shows plan and billing state together.
  subscription: z.enum(['FREE', 'PRO', 'EXPIRED']).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  joinedFrom: dateOnly.optional(),
  joinedTo: dateOnly.optional(),
  ...pageQuery,
});

/**
 * Personality notes. Replacing the whole list rather than patching individual
 * rows keeps ordering under the console's control and makes the "delete list"
 * action a plain empty array.
 */
export const setPersonalitySchema = z.object({
  notes: z.array(z.string().trim().min(1).max(300)).max(30),
});

export const adminUpdateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().toLowerCase().optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    country: z.string().length(2).toUpperCase().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// --- Admins -----------------------------------------------------------------

export const adminListQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  role: z
    .enum(['FITNESS_ADMIN', 'LIFE_COACH_ADMIN', 'SUPPORT_ADMIN', 'MANAGER', 'SUPERADMIN'])
    .optional(),
  status: z.enum(['ACTIVE', 'INVITED', 'DISABLED']).optional(),
  ...pageQuery,
});

export const adminProfileUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().toLowerCase().optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    country: z.string().length(2).toUpperCase().nullable().optional(),
    roles: z
      .array(z.enum(['FITNESS_ADMIN', 'LIFE_COACH_ADMIN', 'SUPPORT_ADMIN', 'MANAGER', 'SUPERADMIN']))
      .min(1)
      .max(5)
      .optional(),
    status: z.enum(['ACTIVE', 'INVITED', 'DISABLED']).optional(),
    isAvailable: z.boolean().optional(),
    maxClients: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// --- Chats ------------------------------------------------------------------

export const adminChatListQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['LIFE_COACH', 'FITNESS', 'SUPPORT']).optional(),
  unreadOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ...pageQuery,
});

// --- Plans ------------------------------------------------------------------

export const adminPlanQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'EXPIRED']).optional(),
  country: z.string().max(20).optional(),
  interval: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']).optional(),
  createdFrom: dateOnly.optional(),
  createdTo: dateOnly.optional(),
  ...pageQuery,
});

// --- Content tables ---------------------------------------------------------

/** Shared by the activities, goals, flexible-task and budget tables. */
export const adminContentQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  userEmail: z.string().trim().max(200).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  ...pageQuery,
});

export const adminMealPlanQuerySchema = z.object({
  userEmail: z.string().trim().max(200).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  ...pageQuery,
});

// --- Analytics --------------------------------------------------------------

export const analyticsOverviewQuerySchema = z.object({
  /// How many weekly buckets the trend charts show.
  weeks: z.coerce.number().int().min(4).max(52).default(12),
  /// 'YYYY-MM' scopes every counter and series to that calendar month, which is
  /// what the console's month picker sends. Omitted means "all months".
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
    .optional(),
});
