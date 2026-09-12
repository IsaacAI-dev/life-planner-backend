export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  // Addendum 2
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',
  NOT_A_FLEXIBLE_TASK: 'NOT_A_FLEXIBLE_TASK',
  NOT_A_DATED_TASK: 'NOT_A_DATED_TASK',
  SHARE_NOT_GRANTED: 'SHARE_NOT_GRANTED',
  // Addendum 5
  /// The activity was created on its own, so it has no batch to edit.
  NOT_A_BATCH_ACTIVITY: 'NOT_A_BATCH_ACTIVITY',
  /// A meal-plan request is already in flight; only one may be open at a time.
  MEAL_REQUEST_PENDING: 'MEAL_REQUEST_PENDING',
  /// The plan belongs to a coach, so the person may not overwrite it silently.
  PLAN_NOT_EDITABLE: 'PLAN_NOT_EDITABLE',
  /// Paid-only feature reached on a Free plan. Always paired with a 402.
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCodeValue;
  public readonly details?: unknown;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, code: ErrorCodeValue = ErrorCode.VALIDATION_ERROR, details?: unknown) {
    return new AppError(400, code, message, details);
  }
  static unauthorized(message = 'Authentication required', code: ErrorCodeValue = ErrorCode.UNAUTHORIZED) {
    return new AppError(401, code, message);
  }
  static forbidden(message = 'You do not have access to this resource', code: ErrorCodeValue = ErrorCode.FORBIDDEN) {
    return new AppError(403, code, message);
  }
  static notFound(message = 'Resource not found') {
    return new AppError(404, ErrorCode.NOT_FOUND, message);
  }
  static conflict(message: string, code: ErrorCodeValue = ErrorCode.CONFLICT, details?: unknown) {
    return new AppError(409, code, message, details);
  }
  static internal(message = 'Something went wrong') {
    return new AppError(500, ErrorCode.INTERNAL_ERROR, message);
  }
}
