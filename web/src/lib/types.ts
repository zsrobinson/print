import type { Duplex, PrinterId } from "./limits"

export type { PrinterId }
export type PrinterState = "idle" | "busy" | "stopped" | "offline"
export type JobSource = "web" | "mcp"
/** Ledger states: CUPS job states plus `unknown` when the outcome is unclear. */
export type JobState =
  | "pending"
  | "held"
  | "processing"
  | "stopped"
  | "completed"
  | "canceled"
  | "aborted"
  | "unknown"
/** What the core received: a PDF, an image, text it laid out, or a receipt. */
export type JobKind = "pdf" | "image" | "text" | "receipt"

export type JobOptions = {
  sides?: Duplex
  page_range?: string | null
  color?: "color" | "monochrome"
  paper_size?: string
}

/** Core-defined detail; only known, non-supply fields are ever displayed. */
export type PrinterStatus = Record<string, unknown>

export type Job = {
  id: string
  cups_id?: string | null
  printer: PrinterId
  source: JobSource
  state: JobState | string
  /** Pages per copy actually sent (after any page range). */
  pages: number | null
  copies: number
  created_at: string
  dry_run: boolean
  /** Display name: filename, PDF title, URL basename or first receipt line. Null on old rows. */
  name: string | null
  kind: JobKind | null
  options: JobOptions | null
  finished_at: string | null
  size_bytes: number | null
  /** A plain-language reason when the job failed or its outcome is unknown. */
  error: string | null
  /** When kept bytes or receipt text expire; null when nothing was kept. */
  kept_until: string | null
  /** True while the kept bytes or text still exist. */
  reprintable: boolean
}

export type JobEvent = { state: JobState | string; at: string }

export type JobDetail = Job & {
  events: JobEvent[]
  /** Pages in the whole document, when known (before any page range). */
  document_pages: number | null
  /** The kept receipt text while it is retained. */
  receipt_text?: string | null
}

export type JobsQuery = {
  q?: string
  printer?: PrinterId
  /** `finished` is every state that is not active. */
  status?: "active" | "finished" | "completed" | "failed" | "canceled"
  source?: JobSource
  dry_run?: boolean
  /** Inclusive local calendar dates, YYYY-MM-DD. */
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export type JobsResponse = { jobs: Job[]; total: number }
export type JobResponse = { job: JobDetail }

export type Capabilities = {
  /** Supported `sides` values; empty when the printer does not say. */
  sides: Duplex[]
  /** IPP media names such as na_letter_8.5x11in. */
  media: string[]
  color: boolean | null
  make_model: string | null
}

export type Printer = {
  id: PrinterId
  state: PrinterState
  accepting: boolean | null
  status: PrinterStatus
  capabilities: Capabilities | null
  last_job: Job | null
}

export type PrinterStateChange = {
  state: PrinterState
  at: string
  /** Raw CUPS/IPP reasons at the time of the change. */
  reasons: string[]
}

export type PrinterDetail = Printer & {
  /** State changes, oldest first; the first entry may predate the window. */
  history: PrinterStateChange[]
  recent_jobs: Job[]
  /** The raw CUPS view of this queue (lpstat), ids and states only. */
  queue: string
}

export type PrintersResponse = { printers: Printer[] }
export type PrinterResponse = { printer: PrinterDetail }

export type PrinterCheck = {
  id: "cups" | "queue" | "accepting" | "state" | "device"
  label: string
  ok: boolean | null
  detail: string
}
export type PrinterCheckResponse = {
  printer: PrinterId
  checked_at: string
  ok: boolean
  checks: PrinterCheck[]
}

export type StatsRange = "7d" | "30d" | "90d" | "all"
export type DailyStat = {
  date: string
  printer: PrinterId
  source: JobSource
  jobs: number
  pages: number
  failures: number
}
export type Totals = { jobs: number; pages: number; failures: number }
export type StatsResponse = {
  range: StatsRange
  /** Inclusive local dates covered by `daily`. */
  start: string
  end: string
  /** Real jobs only; dry runs are counted in `totals.dry_runs`. */
  daily: DailyStat[]
  totals: Totals & { dry_runs: number }
  /** The same-length period before `start`; null for `all`. */
  previous: Totals | null
  /** Jobs by local weekday (0 = Monday) and hour. */
  hours: { weekday: number; hour: number; jobs: number }[]
  /** Jobs by pages × copies. */
  sizes: { bucket: "1" | "2–5" | "6–10" | "11–25" | "26+"; jobs: number }[]
  first_job: string | null
}
