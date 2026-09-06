import { logger } from './logger.js';
import { env } from '../config/env.js';

export interface MailPayload {
  to: string;
  subject: string;
  text: string;
}

/**
 * Console transport by default — reminders and password-reset links print to the
 * server log so the whole flow is testable without SMTP credentials.
 */
export async function sendMail(payload: MailPayload): Promise<void> {
  if (env.MAIL_TRANSPORT === 'console') {
    logger.info({ from: env.MAIL_FROM, ...payload }, '📧 [mail]');
    return;
  }
  // A real SMTP transport would go here (nodemailer et al).
  logger.warn({ to: payload.to }, 'SMTP transport not configured; mail dropped');
}
