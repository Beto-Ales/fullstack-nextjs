import { formatCalendarDate, formatHistoryInstant } from "@/src/interfaces/presentation/history-format";

export function HistoryTime({ value, dateOnly = false }: { value?: Date | null; dateOnly?: boolean }) {
  const text = formatHistoryInstant(value, dateOnly);
  return value && text ? <time dateTime={value.toISOString()}>{text}</time> : "Fecha sin registrar";
}

export function CalendarDate({ value }: { value?: string | null }) {
  const text = formatCalendarDate(value);
  return value && text ? <time dateTime={value}>{text}</time> : "Fecha sin registrar";
}
