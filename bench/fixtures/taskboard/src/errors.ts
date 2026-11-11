/** Base class for errors that map to an HTTP-like status code. */
export class AppError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  readonly details: string[];

  constructor(details: string[]) {
    super(400, 'Validation failed');
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
  }
}
