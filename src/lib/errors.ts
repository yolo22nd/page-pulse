import { ApiErrorCode } from '../schemas/audit.schema';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ApiErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UpstreamFetchError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, 'UPSTREAM_FETCH_ERROR', message, details);
  }
}

export class RedirectLimitExceededError extends AppError {
  constructor(message: string = 'Maximum redirect limit of 5 exceeded') {
    super(502, 'REDIRECT_LIMIT_EXCEEDED', message);
  }
}

export class AuditTimeoutError extends AppError {
  constructor(message: string = 'Audit operation timed out') {
    super(504, 'AUDIT_TIMEOUT', message);
  }
}
