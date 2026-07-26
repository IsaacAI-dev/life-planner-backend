import { z } from 'zod';

/** Request a password-reset email. Always answered with 200 to avoid enumeration. */
export const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase(),
});

/** Complete a password reset using the emailed token. */
export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});

/** Change password while authenticated; requires the current password. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

/** Permanently delete the authenticated account; requires password confirmation. */
export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
