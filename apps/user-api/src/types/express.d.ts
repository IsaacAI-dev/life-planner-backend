import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth after verifying the access token. */
      user?: { id: string };
    }
  }
}

export {};
