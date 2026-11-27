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

/** Public processing failures must never include provider, storage, or tenant text. */
export function publicProcessingError(code?: string | null): string {
  return code === 'PAYLOAD_TOO_LARGE'
    ? 'Analysis snapshot exceeds the supported size limit'
    : 'Analysis processing failed. Please retry.';
}

export function publicStoredError(message: string | null | undefined, code?: string | null): string | null {
  return message == null ? null : publicProcessingError(code);
}
