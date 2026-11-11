import { AppError, ValidationError } from '../errors.ts';

/** Minimal request shape a router hands to a handler. */
export interface Request {
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Id of the authenticated user, filled in by the auth layer (absent for anonymous calls). */
  userId?: string;
}

export interface Response {
  status: number;
  body: unknown;
}

export type Handler = (req: Request) => Response;

export function ok(body: unknown, status = 200): Response {
  return { status, body };
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: err.message, details: err.details } };
  }
  if (err instanceof AppError) {
    return { status: err.status, body: { error: err.message } };
  }
  return { status: 500, body: { error: 'Internal server error' } };
}

/** Wrap a handler so thrown errors become error responses. */
export function handle(fn: Handler): Handler {
  return (req) => {
    try {
      return fn(req);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

export function requireParam(req: Request, name: string): string {
  const value = req.params?.[name];
  if (!value) throw new ValidationError([`missing route parameter: ${name}`]);
  return value;
}

export function bodyRecord(req: Request): Record<string, unknown> {
  const { body } = req;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
