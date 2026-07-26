/**
 * Cross-cutting DTOs shared by both apps. Most request/response DTOs are derived
 * directly from Zod schemas via z.infer (see ../schemas) — one source of truth.
 */

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
  createdAt: string;
}

export interface PublicAdmin {
  id: string;
  email: string;
  name: string | null;
  role: 'SUPPORT' | 'SUPERADMIN';
}

export interface AuthResponse {
  user: PublicUser;
  tokens: AuthTokens;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PublicSubscription {
  plan: string;
  status: 'ACTIVE' | 'CANCELED' | 'EXPIRED';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
}

/** Daily assistant-message usage against the free-tier cap. */
export interface MessageUsage {
  used: number;
  limit: number;
  remaining: number;
  subscribed: boolean;
}
