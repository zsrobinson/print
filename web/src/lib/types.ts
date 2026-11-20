import type { PrinterId } from "./limits"

export type { PrinterId }
export type PrinterState = "idle" | "busy" | "stopped" | "offline"
export type JobSource = "web" | "mcp"

/** Core-defined detail; only known, non-supply fields are ever displayed. */
export type PrinterStatus = Record<string, unknown>

export type Printer = {
  id: PrinterId
  state: PrinterState
  status: PrinterStatus
  last_job: Record<string, unknown> | null
}

export type Job = {
  id: string
  cups_id?: string | null
  printer: PrinterId
  source: JobSource
  state: string
  pages: number | null
  copies: number
  created_at: string | number
  dry_run: boolean
}

export type PrintersResponse = { printers: Printer[] }
export type JobsResponse = {
  jobs: Job[]
  cups: Partial<Record<PrinterId, string>>
}
export type DailyStat = {
  date: string
  printer: PrinterId
  source: JobSource
  jobs: number
  pages: number
  failures: number
}
export type Totals = { jobs: number; pages: number; failures: number }
export type StatsResponse = { daily: DailyStat[]; totals: Totals }
