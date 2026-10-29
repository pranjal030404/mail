import { ZodError, type ZodType } from 'zod';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId?: string;
  };
}

/** An error whose code and message are safe to show to the client. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue.') => new AppError(401, 'unauthenticated', message);
export const forbidden = (code = 'forbidden', message = 'You do not have permission to perform this action.') => new AppError(403, code, message);
/** Used for resources outside the caller's tenant, so existence is never revealed. */
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AppError(
        400,
        'validation_failed',
        'Some fields are invalid.',
        err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      );
    }
    throw err;
  }
}
