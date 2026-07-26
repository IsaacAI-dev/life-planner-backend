import { env } from './env.js';
import { logger } from './logger.js';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Mail transport (§13). Defaults to a console transport so the stack runs with
 * zero external config. `smtp`/`resend` are recognized but intentionally fall
 * back to console until credentials are wired, keeping local dev unblocked.
 */
export async function sendMail(mail: OutboundMail): Promise<void> {
  switch (env.MAIL_PROVIDER) {
    case 'smtp':
    case 'resend':
      // TODO: wire nodemailer (SMTP_URL) or the Resend SDK (RESEND_API_KEY).
      logger.warn({ provider: env.MAIL_PROVIDER }, 'mail provider not configured; logging instead');
      logger.info({ from: env.MAIL_FROM, ...mail }, 'outbound mail (fallback)');
      return;
    case 'console':
    default:
      logger.info({ from: env.MAIL_FROM, ...mail }, 'outbound mail (console)');
      return;
  }
}
