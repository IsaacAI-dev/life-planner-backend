import type { Response } from 'express';
import type { ErrorCodeValue, ErrorDetail } from '../errors/index.js';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: ErrorDetail[];
  };
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function okEnvelope<T>(data: T): SuccessEnvelope<T> {
  return { success: true, data };
}

export function failEnvelope(
  code: ErrorCodeValue,
  message: string,
  details?: ErrorDetail[],
): ErrorEnvelope {
  return { success: false, error: { code, message, ...(details ? { details } : {}) } };
}

/** Send a success response. Defaults to 200. */
export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json(okEnvelope(data));
}

/** Send a created (201) success response. */
export function created<T>(res: Response, data: T): Response {
  return ok(res, data, 201);
}

/** Send an error response. */
export function fail(
  res: Response,
  status: number,
  code: ErrorCodeValue,
  message: string,
  details?: ErrorDetail[],
): Response {
  return res.status(status).json(failEnvelope(code, message, details));
}
