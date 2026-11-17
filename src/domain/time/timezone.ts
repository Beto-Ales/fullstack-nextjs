export const CENTER_TIME_ZONE = "Europe/Copenhagen" as const;

export const DATE_TIME_STRATEGY = {
  storage: "Store instants in UTC in PostgreSQL timestamptz columns.",
  display: `Render calendar/business timestamps in ${CENTER_TIME_ZONE}.`,
  note: "Always derive month-based limits using center time zone, not browser local time.",
} as const;

export function formatInCenterTimeZone(
  date: Date,
  locale: Intl.LocalesArgument = "en-GB",
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: CENTER_TIME_ZONE,
    ...options,
  }).format(date);
}

export function isCenterTimeZone(timeZone: string): boolean {
  return timeZone === CENTER_TIME_ZONE;
}

