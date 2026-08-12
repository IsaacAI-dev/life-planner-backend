import { z } from 'zod';
import { dateString } from './common.js';

/** P-21 — header search. */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

/** P-14 */
export const dailyStatsQuerySchema = z
  .object({ from: dateString, to: dateString })
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`', path: ['to'] });

/** P-11 */
export const coachInsightQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

export const createCoachInsightSchema = z.object({
  headline: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2000),
  periodStart: dateString,
  periodEnd: dateString,
});

/** P-17 */
export const featureGoalSchema = z.object({ featured: z.boolean() });

/** P-15 */
export const createCalendarConnectionSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.enum(['GOOGLE', 'APPLE', 'OUTLOOK']),
    label: z.string().trim().max(120).optional(),
  }),
  z.object({
    provider: z.literal('ICS'),
    url: z.string().url().max(500),
    label: z.string().trim().min(1).max(120),
  }),
]);

/** Admin-editable landing-page content. */
export const updateSiteContentSchema = z
  .object({
    contactEmail: z.string().email().max(200).nullable().optional(),
    contactPhone: z.string().trim().max(40).nullable().optional(),
    contactAddress: z.string().trim().max(500).nullable().optional(),
    supportEmail: z.string().email().max(200).nullable().optional(),
    heroHeadline: z.string().trim().max(200).nullable().optional(),
    heroSubhead: z.string().trim().max(400).nullable().optional(),
    heroCtaLabel: z.string().trim().max(60).nullable().optional(),
    features: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(120),
          body: z.string().trim().max(600),
          icon: z.string().trim().max(60).optional(),
        }),
      )
      .max(12)
      .optional(),
    faqs: z
      .array(
        z.object({
          question: z.string().trim().min(1).max(200),
          answer: z.string().trim().min(1).max(2000),
        }),
      )
      .max(30)
      .optional(),
    aboutHeadline: z.string().trim().max(200).nullable().optional(),
    aboutBody: z.string().trim().max(5000).nullable().optional(),
    socialLinks: z.record(z.string().url().max(300)).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const staffMemberSchema = z.object({
  name: z.string().trim().min(1).max(120),
  position: z.string().trim().min(1).max(120),
  bio: z.string().trim().max(2000).optional(),
  imageUrl: z.string().url().max(500).optional(),
  linkedIn: z.string().url().max(300).optional(),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

export const updateStaffMemberSchema = staffMemberSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

/** Extra settings fields (P-12, P-13). */
export const settingsExtrasSchema = z.object({
  textScale: z.enum(['SMALL', 'DEFAULT', 'LARGE', 'LARGEST']).optional(),
  coachCheckInFrequency: z.enum(['OFF', 'DAILY', 'WEEKLY']).optional(),
});

/** Admin ops analytics. */
export const opsReportQuerySchema = z
  .object({
    from: dateString,
    to: dateString,
    granularity: z.enum(['day', 'week', 'month']).default('day'),
  })
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`', path: ['to'] });

export const createAdminV3Schema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(120),
  roles: z
    .array(z.enum(['FITNESS_ADMIN', 'LIFE_COACH_ADMIN', 'SUPPORT_ADMIN', 'MANAGER', 'SUPERADMIN']))
    .min(1)
    .max(5),
  maxClients: z.number().int().min(0).max(1000).default(50),
  bio: z.string().trim().max(1000).optional(),
});

export const updateAdminV3Schema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    roles: z
      .array(z.enum(['FITNESS_ADMIN', 'LIFE_COACH_ADMIN', 'SUPPORT_ADMIN', 'MANAGER', 'SUPERADMIN']))
      .min(1)
      .max(5)
      .optional(),
    isAvailable: z.boolean().optional(),
    maxClients: z.number().int().min(0).max(1000).optional(),
    bio: z.string().trim().max(1000).nullable().optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

/** "This wasn't me" responses. Unauthenticated — the token is the credential. */
export const securityActionResponseSchema = z.object({
  action: z.enum(['REJECT', 'REPORT']),
  note: z.string().trim().max(1000).optional(),
});

export const reviewSecurityReportSchema = z.object({
  reviewNote: z.string().trim().max(2000).optional(),
});

export const securityReportQuerySchema = z.object({
  outcome: z.enum(['REPORTED', 'REJECTED']).optional(),
  type: z.enum(['SEAT_INVITE', 'SIGNUP', 'PASSWORD_RESET']).optional(),
  reviewed: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
