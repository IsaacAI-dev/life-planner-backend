import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  country: z.string().trim().length(2).toUpperCase().optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(1).max(200),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    country: z.string().trim().length(2).toUpperCase().optional(),
    avatarUrl: z.string().url().max(500).optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const adminLoginSchema = loginSchema;

export const createAdminSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['SUPPORT', 'SUPERADMIN']).default('SUPPORT'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateAdminInput = z.infer<typeof createAdminSchema>;
