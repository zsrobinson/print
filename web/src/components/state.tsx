import { cn } from "@zsrobinson/shell"
import { formatDateTime } from "@zsrobinson/shell/lib/format"
import { shortWhen } from "@/lib/dates"
import { Badge } from "@zsrobinson/shell/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@zsrobinson/shell/ui/tooltip"
import {
  FileImageIcon,
  FileTextIcon,
  GlobeIcon,
  ReceiptTextIcon,
  SparklesIcon,
} from "lucide-react"
import {
  jobLabel,
  jobTone,
  PRINTER_STATE,
  toMillis,
  type Tone,
} from "@/lib/jobs"
import type { JobKind, JobSource, PrinterId, PrinterState } from "@/lib/types"

const DOT: Record<Tone, string> = {
  ok: "bg-positive",
  busy: "bg-primary motion-safe:animate-pulse",
  wait: "border border-muted-foreground bg-transparent",
  neutral: "bg-muted-foreground/50",
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
  const tone = jobTone(state, dryRun)
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
        {shortWhen(ms)}
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(iso)}</TooltipContent>
    </Tooltip>
  )
}

/** The kind of job, as an icon: document, image or receipt. */
export function JobIcon({
  printer,
  kind,
  className,
}: {
  printer: PrinterId
  kind?: JobKind | null
  className?: string
}) {
  const Icon =
    printer === "receipt"
      ? ReceiptTextIcon
      : kind === "image"
        ? FileImageIcon
        : FileTextIcon
  return <Icon aria-hidden="true" className={cn("size-4", className)} />
}

export function SourceIcon({
  source,
  className,
}: {
  source: JobSource
  className?: string
}) {
  const Icon = source === "mcp" ? SparklesIcon : GlobeIcon
  return <Icon aria-hidden="true" className={cn("size-3.5", className)} />
}
