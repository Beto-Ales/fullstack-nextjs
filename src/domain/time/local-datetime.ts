import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";

type LocalDateTimeOptions = {
  localDate: string;
  localTime: string;
  timeZone?: string;
};

function parseHourAndMinute(localTime: string): { hour: number; minute: number } {
  const [hourPart, minutePart] = localTime.split(":");
  const hour = Number(hourPart);
  const minute = Number(minutePart);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("Invalid local time format.");
  }

  return { hour, minute };
}

export function resolveLocalDateTime({
  localDate,
  localTime,
  timeZone = CENTER_TIME_ZONE,
}: LocalDateTimeOptions): DateTime {
  const baseDate = DateTime.fromISO(localDate, { zone: timeZone });
  if (!baseDate.isValid) {
    throw new Error("Invalid local date.");
  }

  const { hour, minute } = parseHourAndMinute(localTime);
  let localDateTime = baseDate.set({ hour, minute, second: 0, millisecond: 0 });

  if (!localDateTime.isValid) {
    // If local time is nonexistent because of DST jump, advance minute-by-minute
    // to the next valid local instant (deterministic strategy).
    for (let step = 1; step <= 120; step += 1) {
      const candidate = baseDate
        .plus({ minutes: hour * 60 + minute + step })
        .set({ second: 0, millisecond: 0 });
      if (candidate.isValid) {
        localDateTime = candidate;
        break;
      }
    }
  }

  if (!localDateTime.isValid) {
    throw new Error("Unable to resolve local date-time.");
  }

  return localDateTime;
}

export function toUtcDate(localDateTime: DateTime): Date {
  return localDateTime.toUTC().toJSDate();
}

