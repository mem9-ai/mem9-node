export interface AppErrorOptions {
  statusCode: number;
  code: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  public override readonly cause?: unknown;

  public constructor(message: string, options: AppErrorOptions) {
    super(message);
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message.slice(0, 512);
  }

  return 'Unexpected error';
}
