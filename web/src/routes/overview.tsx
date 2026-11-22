import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  cn,
  Page,
  PageActions,
  PageGrid,
  PageHeader,
  PageTitle,
} from "@zsrobinson/shell"
import {
  DonutChartCard,
  TrendChart,
  type ChartPoint,
  type ChartRangeOption,
} from "@zsrobinson/shell/blocks/chart-card"
import { QueryError } from "@zsrobinson/shell/blocks/query-error"
import { formatCount } from "@zsrobinson/shell/lib/format"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@zsrobinson/shell/ui/card"
import type { ChartConfig } from "@zsrobinson/shell/ui/chart"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@zsrobinson/shell/ui/empty"
import { Skeleton } from "@zsrobinson/shell/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@zsrobinson/shell/ui/toggle-group"
import { ChevronRightIcon } from "lucide-react"
import { useMemo } from "react"
import { HourHeatmap } from "@/components/heatmap"
import { Choice } from "@/components/pickers"
import { JobList, JobListSkeleton } from "@/components/job-list"
import { PrinterIcon, PrinterStateBadge } from "@/components/state"
import { jobsQuery, printersQuery, statsQuery } from "@/lib/api"
import { Meta } from "@/components/meta"
import { usePageTitle } from "@/lib/crumb"
import { fullDate } from "@/lib/dates"
import { jobName, PRINTER_LABELS, SOURCE_LABELS } from "@/lib/jobs"
import type { DailyStat, StatsRange, StatsResponse } from "@/lib/types"

type Metric = "jobs" | "pages" | "failures"
type OverviewSearch = { range?: StatsRange; metric?: Metric }

const RANGES: readonly ChartRangeOption<StatsRange>[] = [
  { value: "7d", label: "Last 7 days", duration: 7 * 86_400 },
  { value: "30d", label: "Last 30 days", duration: 30 * 86_400 },
  { value: "90d", label: "Last 90 days", duration: 90 * 86_400 },
  { value: "all", label: "All time", duration: "all" },
]
const PERIOD: Record<StatsRange, string> = {
  "7d": "prior 7 days",
  "30d": "prior 30 days",
  "90d": "prior 90 days",
  all: "",
}

export const Route = createFileRoute("/overview")({
  validateSearch: (search: Record<string, unknown>): OverviewSearch => ({
    ...(RANGES.some((r) => r.value === search.range) && search.range !== "30d"
      ? { range: search.range as StatsRange }
      : {}),
    ...(search.metric === "jobs" || search.metric === "failures"
      ? { metric: search.metric }
      : {}),
  }),
  staticData: { crumbs: [{ label: "Overview", to: "/overview" }] },
  component: OverviewPage,
})

// Series follow the printer, never its rank. chart-2 matches chart-1 on blue apps.
const PRINTER_SERIES: ChartConfig = {
  document: { label: PRINTER_LABELS.document, color: "var(--chart-1)" },
  receipt: { label: PRINTER_LABELS.receipt, color: "var(--chart-3)" },
}

const DAY = 86_400_000
const utcDay = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`)

/** Days for short ranges, weeks for 90 days, months for all time. */
function series(stats: StatsResponse, metric: Metric) {
  const start = utcDay(stats.start)
  const end = utcDay(stats.end)
  const span = (end - start) / DAY + 1
  const unit: "day" | "week" | "month" =
    span <= 45 ? "day" : span <= 200 ? "week" : "month"
  const bucket = (time: number) => {
    if (unit === "day") return time
    const date = new Date(time)
    if (unit === "month")
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
    // Weeks start on Monday.
    return time - ((date.getUTCDay() + 6) % 7) * DAY
  }
  const rows = new Map<number, ChartPoint>()
  for (let time = start; time <= end; time += DAY) {
    const key = bucket(time)
    if (!rows.has(key)) rows.set(key, { time: key, document: 0, receipt: 0 })
  }
  for (const row of stats.daily) {
    const point = rows.get(bucket(utcDay(row.date)))
    if (point)
      point[row.printer] = (point[row.printer] ?? 0) + (row[metric] || 0)
  }
  return { unit, data: [...rows.values()] }
}

function sum(rows: DailyStat[], key: Metric) {
  return rows.reduce((total, row) => total + (row[key] || 0), 0)
}

function OverviewPage() {
  usePageTitle("Overview")
  const { range = "30d", metric = "pages" } = Route.useSearch()
  const navigate = Route.useNavigate()
  const stats = useQuery(statsQuery(range))
  const recent = useQuery(jobsQuery({ limit: 6 }))
  const printers = useQuery(printersQuery)
  const data = stats.data
  const empty = data && data.totals.jobs === 0 && data.totals.dry_runs === 0

  return (
    <Page>
      <PageHeader className="items-start">
        <div className="flex flex-col gap-1">
          <PageTitle>Overview</PageTitle>
          {data ? (
            <Meta>
              <span>
                {fullDate(data.start)} to {fullDate(data.end)}
              </span>
              {data.totals.dry_runs ? (
                <span>
                  {formatCount(data.totals.dry_runs)} dry{" "}
                  {data.totals.dry_runs === 1 ? "run" : "runs"} left out
                </span>
              ) : null}
            </Meta>
          ) : null}
        </div>
        <PageActions>
          <Choice
            aria-label="Range"
            className="w-40"
            value={range}
            onChange={(next) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  range: next === "30d" ? undefined : (next as StatsRange),
                }),
                replace: true,
              })
            }
            options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
          />
        </PageActions>
      </PageHeader>

      {stats.isError ? (
        <QueryError
          title="Stats could not be loaded"
          error={stats.error}
          onRetry={() => void stats.refetch()}
        />
      ) : empty ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>
              {range === "all"
                ? "Nothing printed yet"
                : `Nothing printed in the ${RANGES.find((r) => r.value === range)?.label.toLowerCase()}`}
            </EmptyTitle>
            <EmptyDescription>
              Charts fill in as documents and receipts are printed.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/" />} nativeButton={false}>
              Print something
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <Kpis stats={data} range={range} />
          <ActivityCard
            stats={data}
            metric={metric}
            onMetric={(next) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  metric: next === "pages" ? undefined : next,
                }),
                replace: true,
              })
            }
          />
          <PageGrid layout="two" className="items-stretch">
            <DonutChartCard
              title="Sent from"
              label="Jobs by where they were sent from"
              totalLabel="Jobs"
              loading={!data}
              data={(["web", "mcp"] as const).map((source, index) => ({
                key: source,
                label: SOURCE_LABELS[source],
                value: sum(
                  (data?.daily ?? []).filter((r) => r.source === source),
                  "jobs"
                ),
                // Sources get their own hues, never the printer pair.
                color: index ? "var(--chart-4)" : "var(--chart-5)",
              }))}
            />
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Job size</CardTitle>
              </CardHeader>
              <CardContent>
                <SizeBars stats={data} />
              </CardContent>
            </Card>
          </PageGrid>
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Busiest hours</CardTitle>
            </CardHeader>
            <CardContent>
              {data ? (
                <HourHeatmap
                  cells={data.hours}
                  label="Jobs by weekday and hour"
                />
              ) : (
                <Skeleton className="h-40 w-full" />
              )}
            </CardContent>
          </Card>
          <PageGrid layout="wide" className="items-stretch">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Recent activity</CardTitle>
                <CardAction>
                  <Button
                    variant="ghost"
                    size="sm"
                    render={<Link to="/jobs" />}
                    nativeButton={false}
                  >
                    All jobs
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                {recent.data ? (
                  recent.data.jobs.length ? (
                    <JobList jobs={recent.data.jobs} header={false} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Nothing has been printed yet.
                    </p>
                  )
                ) : (
                  <JobListSkeleton rows={4} />
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Printers</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="-my-1 flex flex-col">
                  {(printers.data?.printers ?? []).map((printer) => (
                    <li key={printer.id}>
                      <Link
                        to="/printers/$id"
                        params={{ id: printer.id }}
                        className="-mx-2 flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 text-sm outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <PrinterIcon
                          printer={printer.id}
                          className="text-muted-foreground"
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="font-medium">
                            {PRINTER_LABELS[printer.id]}
                          </span>
                          <span className="truncate text-muted-foreground">
                            {printer.last_job
                              ? `Last: ${jobName(printer.last_job)}`
                              : "No jobs yet"}
                          </span>
                        </span>
                        <PrinterStateBadge state={printer.state} />
                        <ChevronRightIcon className="size-4 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                  {printers.isPending ? (
                    <Skeleton className="my-1 h-9 w-full" />
                  ) : null}
                </ul>
              </CardContent>
            </Card>
          </PageGrid>
        </>
      )}
    </Page>
  )
}

function change(current: number, previous: number | undefined) {
  if (previous === undefined) return null
  if (!previous) return current ? null : 0
  return (current - previous) / previous
}

function Kpis({ stats, range }: { stats?: StatsResponse; range: StatsRange }) {
  const totals = stats?.totals
  const previous = stats?.previous ?? undefined
  const rate = (t?: { jobs: number; failures: number }) =>
    t && t.jobs ? t.failures / t.jobs : 0
  const perJob = (t?: { jobs: number; pages: number }) =>
    t && t.jobs ? t.pages / t.jobs : 0
  const tiles = [
    {
      label: "Jobs",
      value: totals ? formatCount(totals.jobs) : null,
      delta: totals ? change(totals.jobs, previous?.jobs) : null,
      good: "up" as const,
    },
    {
      label: "Pages",
      value: totals ? formatCount(totals.pages) : null,
      delta: totals ? change(totals.pages, previous?.pages) : null,
      good: "up" as const,
    },
    {
      label: "Failure rate",
      value: totals
        ? `${(rate(totals) * 100).toFixed(rate(totals) && rate(totals) < 0.1 ? 1 : 0)}%`
        : null,
      detail: totals
        ? `${totals.failures} ${totals.failures === 1 ? "failure" : "failures"}`
        : null,
      // Percentage points, since a rate's own change reads oddly.
      points: totals && previous ? (rate(totals) - rate(previous)) * 100 : null,
      good: "down" as const,
    },
    {
      label: "Pages per job",
      value: totals ? perJob(totals).toFixed(1) : null,
      delta:
        totals && previous ? change(perJob(totals), perJob(previous)) : null,
      good: null,
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label} className="min-w-0 gap-1.5">
          <CardHeader>
            <CardTitle className="text-sm font-normal text-muted-foreground">
              {tile.label}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {tile.value === null ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <span className="text-2xl font-semibold tabular-nums">
                {tile.value}
              </span>
            )}
            <Delta
              delta={"delta" in tile ? tile.delta : null}
              points={"points" in tile ? tile.points : null}
              good={tile.good}
              period={PERIOD[range]}
              detail={"detail" in tile ? tile.detail : null}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function Delta({
  delta,
  points,
  good,
  period,
  detail,
}: {
  delta?: number | null
  points?: number | null
  good: "up" | "down" | null
  period: string
  detail?: string | null
}) {
  const value = points ?? delta
  if (value === null || value === undefined || !period)
    return (
      <span className="text-xs text-muted-foreground">
        {detail ?? (period ? "No earlier data" : "Since the first job")}
      </span>
    )
  const flat =
    Math.abs(value) < (points !== null && points !== undefined ? 0.05 : 0.005)
  const up = value > 0
  const tone =
    flat || good === null
      ? "text-muted-foreground"
      : (up ? good === "up" : good === "down")
        ? "text-positive"
        : "text-negative"
  const text = flat
    ? "No change"
    : points !== null && points !== undefined
      ? `${up ? "+" : "−"}${Math.abs(points).toFixed(1)} pts`
      : `${up ? "+" : "−"}${Math.round(Math.abs(value) * 100)}%`
  return (
    <span className="text-xs text-muted-foreground">
      <span className={cn("font-medium tabular-nums", tone)}>{text}</span> vs{" "}
      {period}
    </span>
  )
}

const METRICS: { id: Metric; label: string }[] = [
  { id: "pages", label: "Pages" },
  { id: "jobs", label: "Jobs" },
  { id: "failures", label: "Failures" },
]

function ActivityCard({
  stats,
  metric,
  onMetric,
}: {
  stats?: StatsResponse
  metric: Metric
  onMetric: (metric: Metric) => void
}) {
  const shaped = useMemo(
    () => (stats ? series(stats, metric) : null),
    [stats, metric]
  )
  const unit = shaped?.unit ?? "day"
  const format = new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    ...(unit === "month"
      ? { month: "long", year: "numeric" }
      : { month: "short", day: "numeric" }),
  })
  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          {METRICS.find((m) => m.id === metric)?.label} by{" "}
          {unit === "day" ? "day" : unit}
        </CardTitle>
        <div>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Measure"
            value={[metric]}
            onValueChange={(values: string[]) => {
              const next = values[0] as Metric | undefined
              if (next) onMetric(next)
            }}
          >
            {METRICS.map((m) => (
              <ToggleGroupItem key={m.id} value={m.id}>
                {m.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent>
        <TrendChart
          kind="bar"
          stacked
          utc
          loading={!shaped}
          data={shaped?.data ?? []}
          config={PRINTER_SERIES}
          label={`${metric} per ${unit} by printer`}
          className="h-64"
          formatTime={(time) =>
            unit === "week"
              ? `Week of ${format.format(time)}`
              : format.format(time)
          }
          formatTimeTick={(time) =>
            new Intl.DateTimeFormat(undefined, {
              timeZone: "UTC",
              ...(unit === "month"
                ? { month: "short" }
                : { month: "short", day: "numeric" }),
            }).format(time)
          }
          legend
        />
      </CardContent>
    </Card>
  )
}

function SizeBars({ stats }: { stats?: StatsResponse }) {
  if (!stats) return <Skeleton className="h-44 w-full" />
  const max = Math.max(1, ...stats.sizes.map((s) => s.jobs))
  const total = stats.sizes.reduce((n, s) => n + s.jobs, 0)
  if (!total)
    return (
      <p className="flex h-44 items-center justify-center text-sm text-muted-foreground">
        Nothing in this range
      </p>
    )
  return (
    <ul className="flex flex-col gap-2.5" aria-label="Jobs by pages per job">
      {stats.sizes.map((size) => (
        <li
          key={size.bucket}
          className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.5rem] items-center gap-3 text-sm"
        >
          <span className="whitespace-nowrap text-muted-foreground tabular-nums">
            {size.bucket} {size.bucket === "1" ? "page" : "pages"}
          </span>
          <span className="h-5 overflow-hidden rounded-[4px] bg-muted">
            <span
              className="block h-full rounded-[4px] bg-chart-1"
              style={{ width: `${(size.jobs / max) * 100}%` }}
            />
          </span>
          <span className="text-right font-medium tabular-nums">
            {formatCount(size.jobs)}
          </span>
        </li>
      ))}
    </ul>
  )
}
