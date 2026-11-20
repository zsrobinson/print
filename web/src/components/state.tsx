import { cn } from "@zsrobinson/shell"
import { formatDateTime, formatRelative } from "@zsrobinson/shell/lib/format"
import { Badge } from "@zsrobinson/shell/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@zsrobinson/shell/ui/tooltip"
import { FileTextIcon, ReceiptTextIcon } from "lucide-react"
import {
  jobLabel,
  jobTone,
  PRINTER_STATE,
  toMillis,
  type Tone,
} from "@/lib/jobs"
import type { PrinterId, PrinterState } from "@/lib/types"

const DOT: Record<Tone, string> = {
  on: "bg-primary",
  busy: "bg-primary/60 motion-safe:animate-pulse",
  off: "bg-muted-foreground/50",
  error: "bg-destructive",
}

export function StateDot({
  tone,
  className,
}: {
  tone: Tone
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", DOT[tone], className)}
    />
  )
}

export function PrinterStateBadge({ state }: { state: PrinterState }) {
  const { label, tone } = PRINTER_STATE[state] ?? {
    label: "Unknown",
    tone: "off",
  }
  return (
    <Badge variant={tone === "error" ? "destructive" : "outline"}>
      <StateDot tone={tone} className="size-1.5" />
      {label}
    </Badge>
  )
}

export function JobStateBadge({
  state,
  dryRun = false,
}: {
  state: string
  dryRun?: boolean
}) {
  const tone = jobTone(state)
  return (
    <Badge variant={tone === "error" ? "destructive" : "outline"}>
      <StateDot tone={tone} className="size-1.5" />
      {jobLabel(state, dryRun)}
    </Badge>
  )
}

export function PrinterIcon({
  printer,
  className,
}: {
  printer: PrinterId
  className?: string
}) {
  const Icon = printer === "receipt" ? ReceiptTextIcon : FileTextIcon
  return <Icon aria-hidden="true" className={cn("size-4", className)} />
}

/** Relative time with the exact time on hover. */
export function When({ value }: { value: unknown }) {
  const ms = toMillis(value)
  if (ms === null) return <span className="text-muted-foreground">—</span>
  const iso = new Date(ms).toISOString()
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={iso} className="tabular-nums" />}>
        {formatRelative(iso)}
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(iso)}</TooltipContent>
    </Tooltip>
  )
}
