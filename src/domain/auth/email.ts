const MULTI_SPACE_REGEX = /\s+/g;

export function normalizeEmail(input: string): string {
  return input.trim().replace(MULTI_SPACE_REGEX, "").toLowerCase();
}

