import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { cn, Page, PageHeader, PageMeta, PageTitle } from "@zsrobinson/shell"
import { QueryError } from "@zsrobinson/shell/blocks/query-error"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@zsrobinson/shell/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@zsrobinson/shell/ui/chart"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@zsrobinson/shell/ui/empty"
import { Skeleton } from "@zsrobinson/shell/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@zsrobinson/shell/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@zsrobinson/shell/ui/toggle-group"
import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { statsQuery } from "@/lib/api"
import { PRINTER_LABELS, SOURCE_LABELS } from "@/lib/jobs"
import type { DailyStat, Totals } from "@/lib/types"

type Metric = keyof Totals
type Split = "printer" | "source"

export const Route = createFileRoute("/stats")({
  validateSearch: (search): { metric?: Metric; split?: Split } => ({
    ...(search.metric === "pages" || search.metric === "failures"
      ? { metric: search.metric }
      : {}),
    ...(search.split === "source" ? { split: "source" as const } : {}),
  }),
  component: StatsPage,
})

const METRICS: { id: Metric; label: string }[] = [
  { id: "jobs", label: "Jobs" },
  { id: "pages", label: "Pages" },
  { id: "failures", label: "Failures" },
]
// Series follow the entity, never its rank, so colours never swap.
const SERIES: Record<Split, ChartConfig> = {
  printer: {
    document: { label: PRINTER_LABELS.document, color: "var(--chart-1)" },
    receipt: { label: PRINTER_LABELS.receipt, color: "var(--chart-4)" },
  },
  source: {
    web: { label: SOURCE_LABELS.web, color: "var(--chart-1)" },
    mcp: { label: SOURCE_LABELS.mcp, color: "var(--chart-4)" },
  },
}
const count = new Intl.NumberFormat()
const day = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})
const dayMs = 86_400_000
const parseDay = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`)

/** One row per calendar day from first to last, so gaps read as zero. */
function byDay(daily: DailyStat[], metric: Metric, split: Split) {
  const known = daily.filter((row) => !Number.isNaN(parseDay(row.date)))
  if (!known.length) return []
  const times = known.map((row) => parseDay(row.date))
  const start = Math.min(...times)
  const end = Math.max(...times)
  const keys = Object.keys(SERIES[split])
  const rows = new Map<number, Record<string, number | string>>()
  for (let time = start; time <= end; time += dayMs)
    rows.set(time, {
      date: new Date(time).toISOString().slice(0, 10),
      ...Object.fromEntries(keys.map((key) => [key, 0])),
    })
  for (const row of known) {
    const target = rows.get(parseDay(row.date))!
    const key = row[split]
    if (key in target) target[key] = Number(target[key]) + (row[metric] || 0)
  }
  return [...rows.values()]
}

function StatsPage() {
  const { metric = "jobs", split = "printer" } = Route.useSearch()
  const navigate = Route.useNavigate()
  const stats = useQuery(statsQuery)
  const daily = useMemo(() => stats.data?.daily ?? [], [stats.data])
  const data = useMemo(
    () => byDay(daily, metric, split),
    [daily, metric, split]
  )
  const config = SERIES[split]
  const keys = Object.keys(config)
  const range =
    data.length > 0
      ? `${day.format(parseDay(String(data[0].date)))} to ${day.format(parseDay(String(data[data.length - 1].date)))}`
      : null

  return (
    <Page>
      <PageHeader>
        <div className="flex flex-col gap-1">
          <PageTitle>Stats</PageTitle>
          {range ? (
            <PageMeta>
              <span>{range}</span>
              <span>{data.length} days</span>
            </PageMeta>
          ) : null}
        </div>
      </PageHeader>
      {stats.isPending ? (
        <Card aria-busy="true" aria-label="Loading stats">
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      ) : stats.isError ? (
        <QueryError
          title="Stats could not be loaded"
          error={stats.error}
          onRetry={() => void stats.refetch()}
        />
      ) : !daily.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No jobs recorded yet</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/" />} nativeButton={false}>
              Print something
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <Card className="gap-0 pt-0">
            <CardHeader className="flex flex-col items-stretch gap-0 border-b p-0! sm:flex-row">
              <div
                role="radiogroup"
                aria-label="Measure"
                className="grid flex-1 grid-cols-3"
              >
                {METRICS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={metric === id}
                    onClick={() =>
                      void navigate({
                        search: (prev) => ({
                          ...prev,
                          metric: id === "jobs" ? undefined : id,
                        }),
                        replace: true,
                      })
                    }
                    className={cn(
                      "relative flex cursor-pointer flex-col gap-1 border-r px-5 py-4 text-left outline-none first:rounded-tl-xl last:border-r-0 focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset sm:last:border-r",
                      "after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:bg-primary after:opacity-0 after:transition-opacity aria-checked:after:opacity-100",
                      "hover:bg-muted/50 aria-checked:bg-muted/40"
                    )}
                  >
                    <span className="text-xs text-muted-foreground">
                      {label}
                    </span>
                    <span className="text-xl leading-none font-medium tabular-nums sm:text-2xl">
                      {count.format(stats.data.totals[id] ?? 0)}
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex items-center px-5 py-3 sm:py-0">
                <ToggleGroup
                  variant="outline"
                  size="sm"
                  spacing={0}
                  aria-label="Split by"
                  value={[split]}
                  onValueChange={(value: string[]) => {
                    const next = value[0] as Split | undefined
                    if (!next) return
                    void navigate({
                      search: (prev) => ({
                        ...prev,
                        split: next === "printer" ? undefined : next,
                      }),
                      replace: true,
                    })
                  }}
                >
                  <ToggleGroupItem value="printer">By printer</ToggleGroupItem>
                  <ToggleGroupItem value="source">By source</ToggleGroupItem>
                </ToggleGroup>
              </div>
            </CardHeader>
            <CardContent className="pt-5">
              <ChartContainer
                config={config}
                className="aspect-auto h-64 w-full"
              >
                <BarChart
                  accessibilityLayer
                  data={data}
                  margin={{ left: -16, right: 4 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                    tickFormatter={(value: string) =>
                      day.format(parseDay(value))
                    }
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    width={40}
                  />
                  <ChartTooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.6 }}
                    content={
                      <ChartTooltipContent
                        labelFormatter={(value) =>
                          day.format(parseDay(String(value)))
                        }
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {keys.map((key, index) => (
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="day"
                      fill={`var(--color-${key})`}
                      // A 2px card-coloured seam keeps stacked fills apart.
                      stroke="var(--card)"
                      strokeWidth={2}
                      radius={index === keys.length - 1 ? [4, 4, 0, 0] : 0}
                      maxBarSize={32}
                    />
                  ))}
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
          <Breakdown daily={daily} />
        </>
      )}
    </Page>
  )
}

function Breakdown({ daily }: { daily: DailyStat[] }) {
  const groups = [
    {
      title: "Printer",
      rows: (["document", "receipt"] as const).map((id) => ({
        id,
        label: PRINTER_LABELS[id],
        ...sum(daily.filter((row) => row.printer === id)),
      })),
    },
    {
      title: "Source",
      rows: (["web", "mcp"] as const).map((id) => ({
        id,
        label: SOURCE_LABELS[id],
        ...sum(daily.filter((row) => row.source === id)),
      })),
    },
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Group</TableHead>
              <TableHead className="text-right">Jobs</TableHead>
              <TableHead className="text-right">Pages</TableHead>
              <TableHead className="text-right">Failures</TableHead>
              <TableHead className="text-right max-sm:hidden">
                Failure rate
              </TableHead>
            </TableRow>
          </TableHeader>
          {groups.map((group) => (
            <TableBody key={group.title}>
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={5}
                  className="pt-4 text-xs font-medium text-muted-foreground"
                >
                  By {group.title.toLowerCase()}
                </TableCell>
              </TableRow>
              {group.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count.format(row.jobs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count.format(row.pages)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count.format(row.failures)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums max-sm:hidden">
                    {row.jobs
                      ? `${((row.failures / row.jobs) * 100).toFixed(1)}%`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          ))}
        </Table>
      </CardContent>
    </Card>
  )
}

function sum(rows: DailyStat[]) {
  return rows.reduce(
    (total, row) => ({
      jobs: total.jobs + (row.jobs || 0),
      pages: total.pages + (row.pages || 0),
      failures: total.failures + (row.failures || 0),
    }),
    { jobs: 0, pages: 0, failures: 0 }
  )
}
