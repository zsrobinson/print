import { cn } from "@zsrobinson/shell"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@zsrobinson/shell/ui/tooltip"
import { PRINTER_STATE } from "@/lib/jobs"
import { useNow } from "@/lib/now"
import type { PrinterState, PrinterStateChange } from "@/lib/types"

const HOUR = 3_600_000

export type Span = {
  state: PrinterState
  from: number
  to: number
  reasons: string[]
}

/** State spans clipped to [start, end]; time before the first record is unknown. */
export function spans(
  history: PrinterStateChange[],
  current: PrinterState,
  start: number,
  end: number
): Span[] {
  const sorted = [...history]
    .map((change) => ({ ...change, time: Date.parse(change.at) }))
    .filter((change) => Number.isFinite(change.time))
    .sort((a, b) => a.time - b.time)
  const result: Span[] = []
  sorted.forEach((change, index) => {
    const from = Math.max(change.time, start)
    const to = Math.min(sorted[index + 1]?.time ?? end, end)
    if (to > from)
      result.push({
        state: change.state,
        from,
        to,
        reasons: change.reasons ?? [],
      })
  })
  if (!sorted.length)
    result.push({ state: current, from: end - 1, to: end, reasons: [] })
  return result
}

const up = (state: PrinterState) => state === "idle" || state === "busy"

/** Share of recorded time the printer was ready or printing. */
export function uptime(list: Span[]) {
  const total = list.reduce((sum, span) => sum + (span.to - span.from), 0)
  if (!total) return null
  return (
    list.reduce(
      (sum, span) => sum + (up(span.state) ? span.to - span.from : 0),
      0
    ) / total
  )
}

type Bucket = {
  from: number
  to: number
  /** Worst state seen, or null when nothing was recorded. */
  state: PrinterState | null
  down: number
}

function buckets(
  list: Span[],
  start: number,
  end: number,
  count: number
): Bucket[] {
  const size = (end - start) / count
  return Array.from({ length: count }, (_, index) => {
    const from = start + index * size
    const to = from + size
    let state: PrinterState | null = null
    let down = 0
    for (const span of list) {
      const overlap = Math.min(span.to, to) - Math.max(span.from, from)
      if (overlap <= 0) continue
      if (!up(span.state)) down += overlap
      if (state === null || RANK[span.state] > RANK[state]) state = span.state
    }
    return { from, to, state, down }
  })
}

const RANK: Record<PrinterState, number> = {
  idle: 0,
  busy: 0,
  offline: 1,
  stopped: 2,
}
const COLOR: Record<PrinterState, string> = {
  idle: "bg-primary/70",
  busy: "bg-primary/70",
  offline: "bg-muted-foreground/55",
  stopped: "bg-destructive",
}

const when = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
})

/**
 * Ready time as a row of bars, worst state per slice: ready, offline (grey)
 * or stopped (red). Slices before the first record stay empty.
 */
export function UptimeStrip({
  history,
  current,
  hours = 168,
  bars = 84,
  className,
}: {
  history: PrinterStateChange[]
  current: PrinterState
  hours?: number
  bars?: number
  className?: string
}) {
  const end = useNow()
  const start = end - hours * HOUR
  const list = spans(history, current, start, end)
  const slices = buckets(list, start, end, bars)
  const share = uptime(list)
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        role="img"
        aria-label={
          share === null
            ? "No state recorded in this period"
            : `Ready ${formatShare(share)} of the recorded time`
        }
        className="flex h-8 items-stretch gap-px"
      >
        {slices.map((slice) => (
          <Tooltip key={slice.from}>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "min-w-0 flex-1 rounded-[2px]",
                    slice.state ? COLOR[slice.state] : "bg-border"
                  )}
                />
              }
            />
            <TooltipContent>
              {when.format(slice.from)} – {when.format(slice.to)}
              <br />
              {slice.state === null
                ? "Not recorded"
                : slice.down > 0
                  ? `${PRINTER_STATE[slice.state].label} for ${Math.max(1, Math.round(slice.down / 60_000))} min`
                  : "Ready"}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>
          {hours >= 48
            ? `${Math.round(hours / 24)} days ago`
            : `${hours} h ago`}
        </span>
        <span>{blockLabel((hours * 60) / bars)}</span>
        <span>Now</span>
      </div>
    </div>
  )
}

export const formatShare = (share: number) =>
  `${share >= 0.9995 ? "100" : (share * 100).toFixed(share > 0.99 ? 1 : 0)}%`

export function UptimeLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {(
        [
          ["Ready", "bg-primary/70"],
          ["Offline", "bg-muted-foreground/55"],
          ["Stopped", "bg-destructive"],
          ["Not recorded", "bg-border"],
        ] as const
      ).map(([label, color]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("size-2.5 rounded-[3px]", color)}
          />
          {label}
        </li>
      ))}
    </ul>
  )
}

function blockLabel(minutes: number) {
  return minutes >= 60
    ? `${Math.round(minutes / 60)}-hour blocks`
    : `${Math.round(minutes)}-minute blocks`
}
