import {
  AppError,
  verifyPassword,
  type AdminLoginInput,
  type PublicAdmin,
} from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';
import { jwtService, signAdminRefresh, verifyAdminRefresh } from '../../jwt.js';

function toPublic(a: { id: string; email: string; name: string | null; role: 'SUPPORT' | 'SUPERADMIN' }): PublicAdmin {
  return { id: a.id, email: a.email, name: a.name, role: a.role };
}

function issueTokens(admin: { id: string; role: 'SUPPORT' | 'SUPERADMIN' }) {
  return {
    accessToken: jwtService.signAdminAccess(admin.id, admin.role),
    refreshToken: signAdminRefresh(admin.id, admin.role),
  };
}

export async function login(input: AdminLoginInput) {
  const admin = await prisma.admin.findUnique({ where: { email: input.email } });
  // Constant-ish failure: same error whether email or password is wrong.
  if (!admin || !(await verifyPassword(admin.passwordHash, input.password))) {
    throw AppError.unauthorized('Invalid credentials');
  }
  return { admin: toPublic(admin), tokens: issueTokens(admin) };
}

export async function refresh(refreshToken: string) {
  const claims = verifyAdminRefresh(refreshToken);
  const admin = await prisma.admin.findUnique({ where: { id: claims.sub } });
  if (!admin) throw AppError.unauthorized('Admin no longer exists');
  return { tokens: issueTokens(admin) };
}

export async function getMe(adminId: string): Promise<PublicAdmin> {
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin) throw AppError.notFound('Admin not found');
  return toPublic(admin);
}
