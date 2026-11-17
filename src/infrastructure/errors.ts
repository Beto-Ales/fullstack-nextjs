export class ApplicationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 500,
    public readonly expose: boolean = false,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}

export function getPublicErrorMessage(error: unknown): string {
  if (isApplicationError(error) && error.expose) {
    return error.message;
  }
  return "Unexpected server error.";
}

