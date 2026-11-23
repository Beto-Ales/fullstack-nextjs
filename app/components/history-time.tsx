import { describeCalendarDate, describeHistoryInstant, formatCalendarDate, formatHistoryInstant } from "@/src/interfaces/presentation/history-format";
import { HistoryText } from "./history-text";

export function HistoryTime({ value, dateOnly = false }: { value?: Date | null; dateOnly?: boolean }) {
  const text = formatHistoryInstant(value, dateOnly);
  return value && text ? (
    <time dateTime={value.toISOString()}><HistoryText text={text} speech={describeHistoryInstant(value, text, dateOnly)} /></time>
  ) : "Fecha sin registrar";
}

export function CalendarDate({ value }: { value?: string | null }) {
  const text = formatCalendarDate(value);
  return value && text ? <time dateTime={value}><HistoryText text={text} speech={describeCalendarDate(value)} /></time> : "Fecha sin registrar";
}
