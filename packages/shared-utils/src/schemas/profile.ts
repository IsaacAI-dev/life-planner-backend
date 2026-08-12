import { z } from 'zod';

const currentYear = new Date().getUTCFullYear();

/** P-06 — demographic fields, split from the session-hot PATCH /auth/me. */
export const updateExtendedProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    location: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(80).nullable().optional(),
    heightCm: z.number().int().min(50).max(260).nullable().optional(),
    yearOfBirth: z.number().int().min(1900).max(currentYear - 13).nullable().optional(),
    gender: z.enum(['FEMALE', 'MALE', 'NON_BINARY', 'UNDISCLOSED']).nullable().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    country: z.string().length(2).toUpperCase().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

/** P-07 — base64 upload keeps this a plain JSON route like the rest of the API. */
export const uploadAvatarSchema = z.object({
  imageBase64: z.string().min(16).max(12_000_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

/** Choosing one of the bundled cartoon characters instead of uploading. */
export const selectAvatarPresetSchema = z.object({
  presetKey: z.string().trim().min(1).max(60),
});

export type UpdateExtendedProfileInput = z.infer<typeof updateExtendedProfileSchema>;
