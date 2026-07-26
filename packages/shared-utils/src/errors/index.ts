/**
 * Machine-readable error codes returned to clients in the error envelope.
 * Keep these stable; clients may branch on them.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  LIMIT_REACHED: 'LIMIT_REACHED',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  path?: string;
  message: string;
  [k: string]: unknown;
}

/**
 * Application error carrying an HTTP status + stable code. The central error
 * middleware (see http/errorMiddleware) translates these into the error envelope.
 */
export class AppError extends Error {
  readonly httpStatus: number;
  readonly code: ErrorCodeValue;
  readonly details?: ErrorDetail[];

  constructor(
    code: ErrorCodeValue,
    message: string,
    httpStatus: number,
    details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(message = 'Bad request', details?: ErrorDetail[]) {
    return new AppError(ErrorCode.BAD_REQUEST, message, 400, details);
  }
  static unauthorized(message = 'Unauthorized') {
    return new AppError(ErrorCode.UNAUTHORIZED, message, 401);
  }
  static forbidden(message = 'Forbidden') {
    return new AppError(ErrorCode.FORBIDDEN, message, 403);
  }
  static notFound(message = 'Not found') {
    return new AppError(ErrorCode.NOT_FOUND, message, 404);
  }
  static conflict(message = 'Conflict', details?: ErrorDetail[]) {
    return new AppError(ErrorCode.CONFLICT, message, 409, details);
  }
  static validation(message = 'Validation failed', details?: ErrorDetail[]) {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, 422, details);
  }
  static rateLimited(message = 'Too many requests') {
    return new AppError(ErrorCode.RATE_LIMITED, message, 429);
  }
  /** A plan/usage limit was hit (e.g. daily free message cap). 402 invites an upgrade. */
  static limitReached(message = 'Usage limit reached', details?: ErrorDetail[]) {
    return new AppError(ErrorCode.LIMIT_REACHED, message, 402, details);
  }
  static internal(message = 'Internal server error') {
    return new AppError(ErrorCode.INTERNAL, message, 500);
  }
}
