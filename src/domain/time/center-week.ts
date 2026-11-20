import { DateTime } from "luxon";
import { z } from "zod";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";

export function resolveCenterWeek(input: unknown, now: DateTime) {
  const currentWeek = now.setZone(CENTER_TIME_ZONE).startOf("week");
  const requested = z.iso.date().safeParse(input);
  const week = requested.success
    ? DateTime.fromISO(requested.data, { zone: CENTER_TIME_ZONE }).startOf("week")
    : currentWeek;
  return { currentWeek, week };
}
