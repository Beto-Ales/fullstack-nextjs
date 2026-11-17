import { CENTER_TIME_ZONE, DATE_TIME_STRATEGY } from "@/src/domain/time/timezone";

export function getSystemContext() {
  return {
    centerTimeZone: CENTER_TIME_ZONE,
    dateTimeStrategy: DATE_TIME_STRATEGY,
  };
}

