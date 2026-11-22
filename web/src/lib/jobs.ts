import type { Duplex } from "./limits"
import type { Job, JobKind, JobSource, PrinterId, PrinterState } from "./types"

/**
 * One status scale for jobs and printers: ok (done or ready), busy (printing),
 * wait (queued), neutral (cancelled, dry run, offline) and error.
 */
export type Tone = "ok" | "busy" | "wait" | "neutral" | "error"

const ACTIVE = new Set([
  "pending",
  "held",
  "queued",
  "submitted",
  "processing",
  "printing",
  "stopped",
])
const FAILED = new Set(["aborted", "failed", "error", "unknown"])
const CANCELLED = new Set(["canceled", "cancelled"])

export const isActive = (job: Pick<Job, "state">) =>
  ACTIVE.has(job.state.toLowerCase())

export const canCancel = (job: Job) => isActive(job) && !job.dry_run

export function jobTone(state: string, dryRun = false): Tone {
  const value = state.toLowerCase()
  if (dryRun && value === "completed") return "neutral"
  if (FAILED.has(value)) return "error"
  if (value === "processing" || value === "printing") return "busy"
  if (ACTIVE.has(value)) return "wait"
  if (value === "completed") return "ok"
  return "neutral"
}

const JOB_LABELS: Record<string, string> = {
  pending: "Waiting",
  held: "Held",
  queued: "Waiting",
  submitted: "Sent",
  processing: "Printing",
  printing: "Printing",
  stopped: "Paused",
  completed: "Printed",
  canceled: "Cancelled",
  cancelled: "Cancelled",
  aborted: "Failed",
  failed: "Failed",
  error: "Failed",
  unknown: "Outcome unknown",
}

export function jobLabel(state: string, dryRun = false) {
  const value = state.toLowerCase()
  if (dryRun && value === "completed") return "Dry run"
  if (JOB_LABELS[value]) return JOB_LABELS[value]
  return value ? value[0].toUpperCase() + value.slice(1) : "Unknown"
}

export const isCancelled = (state: string) => CANCELLED.has(state.toLowerCase())

export const PRINTER_LABELS: Record<PrinterId, string> = {
  document: "Document",
  receipt: "Receipt",
}
export const SOURCE_LABELS: Record<JobSource, string> = {
  web: "Web",
  mcp: "Claude",
}

export const PRINTER_STATE: Record<
  PrinterState,
  { label: string; tone: Tone }
> = {
  idle: { label: "Ready", tone: "ok" },
  busy: { label: "Printing", tone: "busy" },
  stopped: { label: "Stopped", tone: "error" },
  offline: { label: "Offline", tone: "neutral" },
}

/** Milliseconds from an ISO string or Unix seconds/milliseconds. */
export function toMillis(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    if (/^\d+(\.\d+)?$/.test(value)) return toMillis(Number(value))
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function pagesLabel(pages: number | null | undefined, copies = 1) {
  if (typeof pages !== "number") return copies > 1 ? `${copies} copies` : "—"
  const base = `${pages} ${pages === 1 ? "page" : "pages"}`
  return copies > 1 ? `${base} · ${copies} copies` : base
}

/** A human name for any job, including rows recorded before names were kept. */
export function jobName(job: Pick<Job, "name" | "printer" | "kind">) {
  if (job.name) return job.name
  if (job.printer === "receipt") return "Untitled receipt"
  return job.kind === "image" ? "Untitled image" : "Untitled document"
}

export const KIND_LABELS: Record<JobKind, string> = {
  pdf: "PDF",
  image: "Image",
  text: "Text, laid out as PDF",
  receipt: "Receipt text",
}

export const SIDES_LABELS: Record<Duplex, string> = {
  "one-sided": "One-sided",
  "two-sided-long-edge": "Two-sided, long edge",
  "two-sided-short-edge": "Two-sided, short edge",
}

export const STATUS_FILTERS = {
  active: "Active",
  completed: "Printed",
  failed: "Failed",
  canceled: "Cancelled",
} as const
export type StatusFilter = keyof typeof STATUS_FILTERS

export const isFailed = (state: string) => FAILED.has(state.toLowerCase())

export const jobIdLabel = (job: { id?: unknown; cups_id?: unknown }) =>
  typeof job.cups_id === "string"
    ? job.cups_id
    : typeof job.id === "string"
      ? job.id.slice(0, 8)
      : "—"
