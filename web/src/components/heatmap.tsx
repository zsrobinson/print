import { cn } from "@zsrobinson/shell"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@zsrobinson/shell/ui/tooltip"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const hourLabel = (hour: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(
    new Date(2026, 0, 5, hour)
  )
/** Axis labels short enough for a phone: 12a, 6a, 12p, 6p (or 0, 6, 12, 18). */
const axisLabel = (hour: number) =>
  hourLabel(hour)
    .replace(/\s?AM$/i, "a")
    .replace(/\s?PM$/i, "p")

/**
 * Jobs by weekday and hour: one cell per hour, shaded by the app hue on a
 * square-root scale so a few busy hours do not wash out the rest.
 */
export function HourHeatmap({
  cells,
  label,
}: {
  cells: { weekday: number; hour: number; jobs: number }[]
  label: string
}) {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  for (const cell of cells)
    if (
      cell.weekday >= 0 &&
      cell.weekday < 7 &&
      cell.hour >= 0 &&
      cell.hour < 24
    )
      grid[cell.weekday][cell.hour] += cell.jobs
  const max = Math.max(1, ...grid.flat())
  const busiest = grid
    .flatMap((row, weekday) =>
      row.map((jobs, hour) => ({ weekday, hour, jobs }))
    )
    .sort((a, b) => b.jobs - a.jobs)[0]
  return (
    <figure className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={
          busiest?.jobs
            ? `${label}. Busiest: ${DAYS[busiest.weekday]} ${hourLabel(busiest.hour)}, ${busiest.jobs} jobs.`
            : `${label}. No jobs in this range.`
        }
        className="grid grid-cols-[2rem_repeat(24,minmax(0,1fr))] gap-[2px] text-xs text-muted-foreground"
      >
        {grid.map((row, weekday) => (
          <div key={weekday} className="contents">
            <span className="flex items-center">{DAYS[weekday]}</span>
            {row.map((jobs, hour) => (
              <Tooltip key={hour}>
                <TooltipTrigger
                  render={
                    <span
                      className={cn(
                        "aspect-square min-h-2 rounded-[3px]",
                        jobs ? "bg-chart-1" : "bg-muted"
                      )}
                      style={
                        jobs
                          ? { opacity: 0.18 + 0.82 * Math.sqrt(jobs / max) }
                          : undefined
                      }
                    />
                  }
                />
                <TooltipContent>
                  {DAYS[weekday]} {hourLabel(hour)}: {jobs}{" "}
                  {jobs === 1 ? "job" : "jobs"}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span
            key={hour}
            className="col-span-1 overflow-visible pt-1 text-[10px] leading-none whitespace-nowrap"
          >
            {hour % 6 === 0 ? axisLabel(hour) : ""}
          </span>
        ))}
      </div>
      <figcaption className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
        Fewer
        {[0.18, 0.45, 0.72, 1].map((opacity) => (
          <span
            key={opacity}
            aria-hidden="true"
            className="size-2.5 rounded-[3px] bg-chart-1"
            style={{ opacity }}
          />
        ))}
        More
      </figcaption>
    </figure>
  )
}
