export const INVALID_CREDENTIALS_MESSAGE = "Credenciales inválidas.";
export const TOO_MANY_ATTEMPTS_MESSAGE = "Demasiados intentos. Inténtalo más tarde.";
export const AUTH_SERVICE_UNAVAILABLE_MESSAGE = "No se pudo iniciar sesión. Inténtalo de nuevo.";

export class AuthServiceError extends Error {
  constructor(public readonly code: "invalid_credentials" | "too_many_attempts", message: string) {
    super(message);
    this.name = "AuthServiceError";
  }
}

