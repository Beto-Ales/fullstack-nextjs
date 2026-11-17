export const SESSION_DURATION_DAYS = 7;
export const SESSION_DURATION_MS = SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000;

export function getSessionCookieName(nodeEnv: "development" | "test" | "production"): string {
  if (nodeEnv === "production") {
    return "__Host-artwork_session";
  }
  return "artwork_session";
}
