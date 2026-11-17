import { DateTime } from "luxon";

import { SESSION_GENERATION_HORIZON_MONTHS } from "@/src/domain/academic/constants";
import { resolveLocalDateTime, toUtcDate } from "@/src/domain/time/local-datetime";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";

export type RecurringTemplateForGeneration = {
  id: string;
  isoWeekday: number;
  startsAtLocalTime: string;
  durationMinutes: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  maxCapacity: number;
};

export type GeneratedSessionCandidate = {
  templateId: string;
  localDate: string;
  startsAtUtc: Date;
  endsAtUtc: Date;
  maxCapacity: number;
};

export function getDefaultHorizonEndDate(now = DateTime.now().setZone(CENTER_TIME_ZONE)): DateTime {
  return now.plus({ months: SESSION_GENERATION_HORIZON_MONTHS }).endOf("day");
}

export function generateRecurringSessionCandidates(
  template: RecurringTemplateForGeneration,
  options?: {
    now?: DateTime;
    horizonEnd?: DateTime;
    timeZone?: string;
  },
): GeneratedSessionCandidate[] {
  const timeZone = options?.timeZone ?? CENTER_TIME_ZONE;
  const now = (options?.now ?? DateTime.now()).setZone(timeZone);
  const horizonEnd = (options?.horizonEnd ?? getDefaultHorizonEndDate(now)).setZone(timeZone);

  const templateStart = DateTime.fromISO(template.effectiveFrom, { zone: timeZone }).startOf("day");
  const templateEnd = template.effectiveTo
    ? DateTime.fromISO(template.effectiveTo, { zone: timeZone }).endOf("day")
    : horizonEnd;

  const rangeStart = now.startOf("day") > templateStart ? now.startOf("day") : templateStart;
  const rangeEnd = horizonEnd < templateEnd ? horizonEnd : templateEnd;

  const candidates: GeneratedSessionCandidate[] = [];

  for (
    let dayCursor = rangeStart.startOf("day");
    dayCursor <= rangeEnd.startOf("day");
    dayCursor = dayCursor.plus({ days: 1 })
  ) {
    if (dayCursor.weekday !== template.isoWeekday) {
      continue;
    }

    const localDate = dayCursor.toISODate();
    if (!localDate) {
      continue;
    }

    const localStart = resolveLocalDateTime({
      localDate,
      localTime: template.startsAtLocalTime,
      timeZone,
    });
    const localEnd = localStart.plus({ minutes: template.durationMinutes });

    candidates.push({
      templateId: template.id,
      localDate,
      startsAtUtc: toUtcDate(localStart),
      endsAtUtc: toUtcDate(localEnd),
      maxCapacity: template.maxCapacity,
    });
  }

  return candidates;
}

