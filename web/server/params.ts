/**
 * Allow-lists for what the browser may ask of the core. Query strings and
 * names are rebuilt from validated values, never forwarded as received.
 */
import { PRINTERS, type PrinterId } from "../src/lib/limits"

export const MAX_QUERY = 100
export const MAX_NAME = 120
export const MAX_URL = 2048
export const JOB_STATUSES = [
  "active",
  "finished",
  "completed",
  "failed",
  "canceled",
]
export const JOB_SOURCES = ["web", "mcp"]
export const STATS_RANGES = ["7d", "30d", "90d", "all"]

export const isPrinter = (value: string): value is PrinterId =>
  (PRINTERS as readonly string[]).includes(value)

type Read = (name: string) => string[]
export type Invalid = { error: string }

/** One value per name; repeats are refused and empty values are absent. */
function single(read: Read, name: string): string | null | Invalid {
  const values = read(name)
  if (values.length > 1) return { error: `Send ${name} once` }
  return values[0] ? values[0] : null
}

/** A real calendar date written as YYYY-MM-DD. */
function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  )
}

/** The core query for GET /internal/jobs, or a reason to refuse. */
export function jobsSearch(read: Read): URLSearchParams | Invalid {
  const search = new URLSearchParams()
  const rules: [string, (value: string) => string | null][] = [
    [
      "q",
      (value) => {
        const text = value.trim()
        if (/\p{Cc}/u.test(text)) return null
        return text.length <= MAX_QUERY ? text : null
      },
    ],
    ["printer", (value) => (isPrinter(value) ? value : null)],
    ["status", (value) => (JOB_STATUSES.includes(value) ? value : null)],
    ["source", (value) => (JOB_SOURCES.includes(value) ? value : null)],
    [
      "dry_run",
      (value) => (value === "true" || value === "false" ? value : null),
    ],
    ["from", (value) => (isDate(value) ? value : null)],
    ["to", (value) => (isDate(value) ? value : null)],
    [
      "limit",
      (value) =>
        /^[1-9]\d{0,2}$/.test(value) && Number(value) <= 100 ? value : null,
    ],
    [
      "offset",
      (value) =>
        /^(0|[1-9]\d{0,5})$/.test(value) && Number(value) <= 100_000
          ? value
          : null,
    ],
  ]
  for (const [name, check] of rules) {
    const value = single(read, name)
    if (value === null) continue
    if (typeof value !== "string") return value
    const valid = check(value)
    if (valid === null) return { error: `Invalid ${name}` }
    if (valid) search.set(name, valid)
  }
  const from = search.get("from")
  const to = search.get("to")
  if (from && to && from > to)
    return { error: "The start date must not be after the end date" }
  return search
}

export function statsSearch(read: Read): URLSearchParams | Invalid {
  const search = new URLSearchParams()
  const range = single(read, "range")
  if (range === null) return search
  if (typeof range !== "string") return range
  if (!STATS_RANGES.includes(range))
    return { error: "Range must be 7d, 30d, 90d or all" }
  search.set("range", range)
  return search
}

/** Control and format characters out, whitespace collapsed; null when empty. */
export function cleanName(value: string) {
  const text = value
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return null
  return Array.from(text).slice(0, MAX_NAME).join("").trim()
}

/** A public https link for the core to fetch; the core repeats every check. */
export function linkUrl(value: unknown): string | Invalid {
  if (typeof value !== "string" || !value.trim())
    return { error: "Paste a link to a PDF" }
  const text = value.trim()
  if (text.length > MAX_URL)
    return { error: "Links can be up to 2,048 characters" }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { error: "That is not a valid link" }
  }
  if (url.protocol !== "https:")
    return { error: "Only https links can be fetched" }
  if (url.username || url.password)
    return { error: "Links with a username or password are not fetched" }
  if (!url.hostname) return { error: "That is not a valid link" }
  url.hash = ""
  if (url.href.length > MAX_URL)
    return { error: "Links can be up to 2,048 characters" }
  return url.href
}
