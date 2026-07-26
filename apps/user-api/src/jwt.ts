import { createJwt } from '@life-planner/shared-utils';
import { env } from './env.js';

export const jwtService = createJwt({
  accessSecret: env.JWT_ACCESS_SECRET,
  refreshSecret: env.JWT_REFRESH_SECRET,
  adminSecret: env.ADMIN_JWT_SECRET,
  accessTtl: env.ACCESS_TOKEN_TTL,
  refreshTtl: env.REFRESH_TOKEN_TTL,
});
