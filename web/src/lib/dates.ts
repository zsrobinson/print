import { formatRelative } from "@zsrobinson/shell/lib/format"

/** Local calendar dates as YYYY-MM-DD, the format the ledger filters use. */
export const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })
/** "Nov 22, 2026" for a YYYY-MM-DD local date. */
export function fullDate(value: string) {
  const [y, m, d] = value.split("-").map(Number)
  return full.format(new Date(y, m - 1, d))
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})
const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })
/** "Nov 22, 2026, 4:05 PM", or just the time for today. */
export function stamp(iso: string, now = new Date()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return isoDate(date) === isoDate(now)
    ? `Today, ${time.format(date)}`
    : dateTime.format(date)
}

/** "4 min", "2 h 5 min" between two ISO times. */
export function elapsed(from: string, to: string) {
  const seconds = Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000)
  if (!Number.isFinite(seconds)) return null
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48)
    return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  return `${Math.round(hours / 24)} days`
}

/** Relative within a day ("5 minutes ago"), then a date ("Nov 21"). */
export function shortWhen(ms: number, now = Date.now()) {
  if (now - ms < 86_400_000)
    return formatRelative(new Date(ms).toISOString(), now)
  const date = new Date(ms)
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" as const }
      : {}),
  }).format(date)
}
