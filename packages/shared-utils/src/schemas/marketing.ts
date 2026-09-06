import { z } from 'zod';
import { pageQuery } from './adminConsole.js';

/**
 * Marketing site — the seven public endpoints and their admin CRUD.
 *
 * A few values here are a contract with the frontend rather than our own
 * taxonomy: the five screen keys and the six contact topics are matched
 * verbatim on the client, so they live in one place and are validated on the
 * way in rather than hoped for on the way out.
 */

// --- Shared vocabulary ------------------------------------------------------

/** The screens carousel, in the order the site renders it. */
export const MARKETING_SCREEN_KEYS = ['today', 'calendar', 'goals', 'boards', 'chat'] as const;
export type MarketingScreenKey = (typeof MARKETING_SCREEN_KEYS)[number];

export const MARKETING_ASSET_SLOTS = [
  'HERO_PREVIEW',
  'SCREEN',
  'BEND_PRIMARY',
  'BEND_DETAIL',
  'TESTIMONIAL_PORTRAIT',
  'ABOUT_HERO',
  'TEAM_PORTRAIT',
] as const;
export type MarketingAssetSlotName = (typeof MARKETING_ASSET_SLOTS)[number];

/** Slots that hold exactly one image. Their key is always `main`. */
export const SINGLE_IMAGE_SLOTS = ['HERO_PREVIEW', 'BEND_PRIMARY', 'BEND_DETAIL', 'ABOUT_HERO'] as const;

/** Slots whose rows are people, and whose `label` is emitted as `name`. */
export const PORTRAIT_SLOTS = ['TESTIMONIAL_PORTRAIT', 'TEAM_PORTRAIT'] as const;

/** The six options in the contact form's dropdown, verbatim. */
export const CONTACT_TOPICS = [
  'Just saying hello',
  'Something is broken',
  'Billing or my Plus plan',
  'Coaching / team accounts',
  'A feature I wish existed',
  'Press or partnerships',
] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

const imageUrl = z.string().url().max(500);

// --- 1. Marketing assets ----------------------------------------------------

/**
 * Upsert keyed on (slot, key) rather than id: filling a slot is the same
 * operation whether or not a row for it already exists, and the console should
 * not have to look one up first.
 */
export const upsertMarketingAssetSchema = z
  .object({
    slot: z.enum(MARKETING_ASSET_SLOTS),
    key: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use a lowercase slug, e.g. `today` or `priya-raman`')
      .optional(),
    /// Emitted verbatim as `name` for portrait slots.
    label: z.string().trim().min(1).max(120).nullable().optional(),
    imageUrl: imageUrl.nullable().optional(),
    alt: z.string().trim().max(300).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    active: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (!SINGLE_IMAGE_SLOTS.includes(v.slot as never) && !v.key && !v.label) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key'],
        message: 'Provide a key (or a label to derive one from) for this slot',
      });
    }
    if (v.slot === 'SCREEN' && v.key && !MARKETING_SCREEN_KEYS.includes(v.key as MarketingScreenKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key'],
        message: `Screen keys the site renders are: ${MARKETING_SCREEN_KEYS.join(', ')}`,
      });
    }
  });

export const updateMarketingAssetSchema = z
  .object({
    label: z.string().trim().min(1).max(120).nullable().optional(),
    imageUrl: imageUrl.nullable().optional(),
    alt: z.string().trim().max(300).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const marketingAssetQuerySchema = z.object({
  slot: z.enum(MARKETING_ASSET_SLOTS).optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
});

// --- 2. FAQs ----------------------------------------------------------------

export const marketingFaqSchema = z.object({
  question: z.string().trim().min(1).max(200),
  answer: z.string().trim().min(1).max(2000),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
});

export const updateMarketingFaqSchema = marketingFaqSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

/** Drag-and-drop reordering: the whole order arrives at once, not one row at a time. */
export const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export const includeInactiveQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).default('false'),
});

// --- 4. Career roles --------------------------------------------------------

export const careerRoleSchema = z.object({
  title: z.string().trim().min(1).max(160),
  // slug is intentionally absent here: the API auto-generates it from title.
  // It can be overridden via PATCH after creation if needed.
  department: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4000),
  location: z.string().trim().min(1).max(160),
  employmentType: z.string().trim().min(1).max(60),
  compensation: z.string().trim().max(80).nullable().optional(),
  applyUrl: z.string().url().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  published: z.boolean().default(true),
});

export const updateCareerRoleSchema = careerRoleSchema
  .extend({
    /// Only settable via explicit PATCH — auto-generated on create.
    slug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Slug must be lowercase letters, numbers and hyphens')
      .optional(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const careerRoleQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  department: z.string().trim().min(1).max(80).optional(),
  published: z.enum(['true', 'false']).optional(),
  ...pageQuery,
});

// --- 5. App links -----------------------------------------------------------

export const upsertAppLinkSchema = z.object({
  platform: z.enum(['APP_STORE', 'PLAY_STORE']),
  url: z.string().url().max(500),
  badgeImageUrl: imageUrl,
  active: z.boolean().default(true),
});

export const updateAppLinkSchema = z
  .object({
    url: z.string().url().max(500).optional(),
    badgeImageUrl: imageUrl.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// --- 6. Legal consent -------------------------------------------------------

export const createLegalConsentSchema = z.object({
  /// A date works well as a version string, but anything stable is fine.
  version: z.string().trim().min(1).max(40),
  /**
   * A lead-in fragment, not a sentence: the frontend appends its own "Terms &
   * Conditions" and "Privacy Policy" links, so a trailing period would land
   * mid-sentence.
   */
  summary: z.string().trim().min(1).max(300),
  publish: z.boolean().default(false),
});

export const updateLegalConsentSchema = z
  .object({
    version: z.string().trim().min(1).max(40).optional(),
    summary: z.string().trim().min(1).max(300).optional(),
    publish: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// --- 7. Contact submissions -------------------------------------------------

/**
 * The public payload. Validated here as well as on the client, because a
 * client-side check is a courtesy to the person filling the form, not a
 * guarantee about what reaches us.
 */
export const createContactSubmissionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).toLowerCase(),
  topic: z.enum(CONTACT_TOPICS),
  message: z.string().trim().min(1).max(5000),
});

export const contactSubmissionQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['NEW', 'READ', 'REPLIED', 'ARCHIVED', 'SPAM']).optional(),
  topic: z.enum(CONTACT_TOPICS).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ...pageQuery,
});

export const updateContactSubmissionSchema = z
  .object({
    status: z.enum(['NEW', 'READ', 'REPLIED', 'ARCHIVED', 'SPAM']).optional(),
    internalNote: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// --- About Us / public staff profiles (on Admin) ----------------------------

export const updateAdminStaffProfileSchema = z
  .object({
    isPublic: z.boolean().optional(),
    staffRole: z.string().trim().min(1).max(120).nullable().optional(),
    photoUrl: z.string().url().max(500).nullable().optional(),
    favQuote: z.string().trim().max(300).nullable().optional(),
    linkedIn: z.string().url().max(300).nullable().optional(),
    staffSortOrder: z.number().int().min(0).max(9999).optional(),
    /// bio is already on Admin via updateAdminV3Schema; repeated here so the
    /// About Us panel in the console can update it without navigating away.
    bio: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// --- /terms and /privacy legal documents ------------------------------------

const legalSectionSchema = z.object({
  h: z.string().trim().min(1).max(200),
  p: z.string().trim().min(1).max(10000),
});

export const createLegalDocumentSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, 'Slug must be lowercase, e.g. "terms" or "privacy"'),
  version: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  intro: z.string().trim().min(1).max(1000),
  sections: z.array(legalSectionSchema).min(1).max(50),
  publish: z.boolean().default(false),
});

export const updateLegalDocumentSchema = z
  .object({
    version: z.string().trim().min(1).max(40).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    intro: z.string().trim().min(1).max(1000).optional(),
    sections: z.array(legalSectionSchema).min(1).max(50).optional(),
    publish: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const legalDocumentQuerySchema = z.object({
  slug: z.string().trim().min(1).max(40).optional(),
  ...pageQuery,
});
