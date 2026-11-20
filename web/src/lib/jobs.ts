import type { Job, JobSource, PrinterId, PrinterState } from "./types"

export type Tone = "on" | "busy" | "off" | "error"

const ACTIVE = new Set([
  "pending",
  "held",
  "queued",
  "submitted",
  "processing",
  "printing",
  "stopped",
])
const FAILED = new Set(["aborted", "failed", "error"])
const CANCELLED = new Set(["canceled", "cancelled"])

export const isActive = (job: Pick<Job, "state">) =>
  ACTIVE.has(job.state.toLowerCase())

export const canCancel = (job: Job) => isActive(job) && !job.dry_run

export function jobTone(state: string): Tone {
  const value = state.toLowerCase()
  if (FAILED.has(value)) return "error"
  if (value === "processing" || value === "printing") return "busy"
  if (ACTIVE.has(value)) return "on"
  return "off"
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
}

export function jobLabel(state: string, dryRun = false) {
  const value = state.toLowerCase()
  if (dryRun && value === "completed") return "Checked"
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
  mcp: "MCP",
}

export const PRINTER_STATE: Record<
  PrinterState,
  { label: string; tone: Tone }
> = {
  idle: { label: "Ready", tone: "on" },
  busy: { label: "Printing", tone: "busy" },
  stopped: { label: "Stopped", tone: "error" },
  offline: { label: "Offline", tone: "off" },
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
  if (typeof pages !== "number") return copies > 1 ? `× ${copies}` : "—"
  const base = `${pages} ${pages === 1 ? "page" : "pages"}`
  return copies > 1 ? `${base} × ${copies}` : base
}
