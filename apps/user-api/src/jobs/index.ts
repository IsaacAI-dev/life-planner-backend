import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../logger.js';
import { materializeRecurring } from './recurring.job.js';
import { dispatchDueReminders } from './reminders.job.js';

/**
 * Starts in-process schedulers. Single-instance friendly; for multi-instance
 * deployments move these to a dedicated worker (or add a Redis lock) so jobs
 * don't double-run. Returns handles so server shutdown can stop them.
 */
export function startJobs(): ScheduledTask[] {
  // Reminders: every minute.
  const reminders = cron.schedule('* * * * *', () => {
    void dispatchDueReminders().catch((err) => logger.error({ err }, 'reminder job crashed'));
  });

  // Recurring materialization: hourly, plus once at boot.
  const recurring = cron.schedule('0 * * * *', () => {
    void materializeRecurring().catch((err) => logger.error({ err }, 'recurring job crashed'));
  });

  void materializeRecurring().catch((err) => logger.error({ err }, 'initial recurring run failed'));

  logger.info('background jobs scheduled');
  return [reminders, recurring];
}
