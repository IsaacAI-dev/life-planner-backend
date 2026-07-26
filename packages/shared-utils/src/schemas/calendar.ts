import { z } from 'zod';
import { dateString } from './common.js';

export const calendarRangeQuerySchema = z
  .object({
    from: dateString,
    to: dateString,
  })
  .refine((v) => v.to >= v.from, { message: 'to must be on or after from', path: ['to'] });

export const calendarWeekQuerySchema = z.object({
  start: dateString,
});

export type CalendarRangeQuery = z.infer<typeof calendarRangeQuerySchema>;
export type CalendarWeekQuery = z.infer<typeof calendarWeekQuerySchema>;
