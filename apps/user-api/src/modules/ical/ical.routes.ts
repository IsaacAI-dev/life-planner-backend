import { Router } from 'express';
import { asyncHandler, ok } from '@life-planner/shared-utils';
import { currentUserId, requireAuth } from '../../middleware/auth.js';
import * as svc from './ical.service.js';

export const icalRouter = Router();

/**
 * Authed: returns the user's personal subscribe URL. The token in the URL is
 * what grants public read access to the feed below, so treat it like a secret.
 */
icalRouter.get('/feed-url', requireAuth, asyncHandler(async (req, res) => {
  const userId = currentUserId(req);
  const token = svc.signFeedToken(userId);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  ok(res, { url: svc.buildFeedUrl(baseUrl, token) });
}));

/**
 * Public (no auth): the actual ICS document. The path is `/feed/<token>.ics`;
 * we capture the whole filename and strip `.ics` so dots inside the JWT token
 * don't confuse route matching.
 */
icalRouter.get('/feed/:file', asyncHandler(async (req, res) => {
  const token = req.params.file.replace(/\.ics$/i, '');
  const userId = svc.verifyFeedToken(token);
  const ics = await svc.renderUserCalendar(userId);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="life-planner.ics"');
  res.send(ics);
}));
