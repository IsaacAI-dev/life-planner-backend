import 'express';
import type { AdminRoleClaim } from '@life-planner/shared-utils';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: { id: string; role: AdminRoleClaim };
    }
  }
}

export {};
