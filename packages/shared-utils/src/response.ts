/** Structural subset of express' Response — keeps shared-utils dependency-free. */
export interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const ok = <T>(data: T): SuccessEnvelope<T> => ({ success: true, data });

export const fail = (code: string, message: string, details?: unknown): ErrorEnvelope => ({
  success: false,
  error: details === undefined ? { code, message } : { code, message, details },
});

/** Small helper so handlers can `return sendOk(res, { activity })`. */
export const sendOk = <T>(res: ResponseLike, data: T, statusCode = 200) =>
  res.status(statusCode).json(ok(data));

export const sendFail = (
  res: ResponseLike,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
) => res.status(statusCode).json(fail(code, message, details));

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const paginate = <T>(items: T[], page: number, pageSize: number, total: number): Paginated<T> => ({
  items,
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});
