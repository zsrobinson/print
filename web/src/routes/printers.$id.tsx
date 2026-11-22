import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, notFound } from "@tanstack/react-router"
import {
  cn,
  Page,
  PageActions,
  PageGrid,
  PageHeader,
  PageStack,
  PageTitle,
  toast,
} from "@zsrobinson/shell"
import {
  DetailList,
  DetailRow,
  Unavailable,
} from "@zsrobinson/shell/blocks/detail-list"
import { QueryError } from "@zsrobinson/shell/blocks/query-error"
import { errorMessage } from "@zsrobinson/shell/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@zsrobinson/shell/ui/alert"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@zsrobinson/shell/ui/card"
import { Skeleton } from "@zsrobinson/shell/ui/skeleton"
import { Spinner } from "@zsrobinson/shell/ui/spinner"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  StethoscopeIcon,
} from "lucide-react"
import { useState } from "react"
import { JobList } from "@/components/job-list"
import { PrinterStateBadge, When } from "@/components/state"
import {
  formatShare,
  spans,
  uptime,
  UptimeLegend,
  UptimeStrip,
} from "@/components/uptime"
import { checkPrinter, printerQuery } from "@/lib/api"
import { Meta } from "@/components/meta"
import { usePageTitle } from "@/lib/crumb"
import { useNow } from "@/lib/now"
import { elapsed, stamp } from "@/lib/dates"
import { PRINTER_LABELS, PRINTER_STATE } from "@/lib/jobs"
import { PRINTERS, type PrinterId } from "@/lib/limits"
import { describeReasons, mediaLabel } from "@/lib/reasons"
import type { PrinterCheckResponse, PrinterDetail } from "@/lib/types"

export const Route = createFileRoute("/printers/$id")({
  params: {
    parse: ({ id }) => {
      if (!PRINTERS.includes(id as PrinterId)) throw notFound()
      return { id: id as PrinterId }
    },
    stringify: ({ id }) => ({ id }),
  },
  staticData: { crumbs: [{ label: "Printers", to: "/printers" }] },
  component: PrinterPage,
})

function PrinterPage() {
  const { id } = Route.useParams()
  const printer = useQuery(printerQuery(id))
  usePageTitle(`${PRINTER_LABELS[id]} printer`, true)
  if (printer.isError)
    return (
      <Page>
        <QueryError
          title="This printer could not be loaded"
          error={printer.error}
          onRetry={() => void printer.refetch()}
        />
      </Page>
    )
  if (!printer.data) return <PrinterSkeleton />
  return <PrinterView printer={printer.data.printer} />
}

function PrinterView({ printer }: { printer: PrinterDetail }) {
  const [check, setCheck] = useState<PrinterCheckResponse | null>(null)
  const run = useMutation({
    mutationFn: () => checkPrinter(printer.id),
    onSuccess: (result) => {
      setCheck(result)
      if (result.ok) toast.success("Printer check passed")
      else toast.error("The printer check found a problem")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const reasons = describeReasons(printer.status?.reasons)
  const message =
    typeof printer.status?.printer_state_message === "string"
      ? printer.status.printer_state_message.trim()
      : ""
  const label = PRINTER_LABELS[printer.id]
  const model = printer.capabilities?.make_model

  return (
    <Page>
      <PageHeader className="items-start">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <PageTitle>{label} printer</PageTitle>
            <PrinterStateBadge state={printer.state} />
          </div>
          <Meta>
            {model ? <span>{model}</span> : null}
            {printer.status?.queried_at !== undefined ? (
              <span>
                Checked <When value={printer.status.queried_at} />
              </span>
            ) : null}
          </Meta>
        </div>
        <PageActions>
          <Button
            variant="outline"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <StethoscopeIcon data-icon="inline-start" />
            )}
            Check printer
          </Button>
          <Button
            render={
              <Link
                to="/"
                search={printer.id === "receipt" ? { printer: "receipt" } : {}}
              />
            }
            nativeButton={false}
          >
            {printer.id === "receipt" ? "Print a receipt" : "Print a document"}
          </Button>
        </PageActions>
      </PageHeader>

      {reasons
        .filter((reason) => reason.severity !== "info")
        .map((reason) => (
          <Alert
            key={reason.reason}
            variant={reason.severity === "error" ? "destructive" : "default"}
          >
            <CircleAlertIcon />
            <AlertTitle>{reason.title}</AlertTitle>
            <AlertDescription>
              {reason.action ?? "Check the printer's screen."}{" "}
              <span className="font-mono text-xs opacity-70">
                {reason.reason}
              </span>
            </AlertDescription>
          </Alert>
        ))}

      {check ? (
        <CheckCard check={check} onDismiss={() => setCheck(null)} />
      ) : null}

      <PageGrid layout="wide">
        <PageStack>
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList>
                <DetailRow label="State">
                  {PRINTER_STATE[printer.state]?.label ?? printer.state}
                </DetailRow>
                <DetailRow label="Message">
                  {message ? (
                    <span className="truncate font-normal">{message}</span>
                  ) : (
                    <Unavailable>None</Unavailable>
                  )}
                </DetailRow>
                {reasons
                  .filter((r) => r.severity === "info")
                  .map((reason) => (
                    <DetailRow key={reason.reason} label="Reports">
                      <span className="truncate font-normal">
                        {reason.title}
                      </span>
                    </DetailRow>
                  ))}
              </DetailList>
            </CardContent>
          </Card>
          <UptimeCard printer={printer} />
          <Card>
            <CardHeader>
              <CardTitle>Recent jobs</CardTitle>
              <CardAction>
                <Button
                  variant="ghost"
                  size="sm"
                  render={<Link to="/jobs" search={{ printer: printer.id }} />}
                  nativeButton={false}
                >
                  All jobs
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {printer.recent_jobs.length ? (
                <JobList jobs={printer.recent_jobs} header={false} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing has been sent to this printer yet.
                </p>
              )}
            </CardContent>
          </Card>
        </PageStack>
        <PageStack>
          <Capabilities printer={printer} />
          <TechnicalCard printer={printer} />
        </PageStack>
      </PageGrid>
    </Page>
  )
}

function UptimeCard({ printer }: { printer: PrinterDetail }) {
  const now = useNow()
  const list = spans(printer.history, printer.state, now - 7 * 86_400_000, now)
  const share = uptime(list)
  const outages = list
    .filter((span) => span.state === "offline" || span.state === "stopped")
    .reverse()
    .slice(0, 5)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last 7 days</CardTitle>
        <CardAction className="text-sm text-muted-foreground tabular-nums">
          {share === null ? "No record" : `${formatShare(share)} ready`}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <UptimeStrip history={printer.history} current={printer.state} />
        <UptimeLegend />
        {outages.length ? (
          <ul className="-my-2 flex flex-col divide-y divide-border/70 text-sm">
            {outages.map((span) => (
              <li
                key={span.from}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2"
              >
                <span className="flex items-center gap-2 font-medium">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      span.state === "stopped"
                        ? "bg-destructive"
                        : "bg-muted-foreground/60"
                    )}
                  />
                  {PRINTER_STATE[span.state].label}
                  {span.reasons.length ? (
                    <span className="font-normal text-muted-foreground">
                      · {describeReasons(span.reasons)[0]?.title}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {stamp(new Date(span.from).toISOString())} ·{" "}
                  <span className="whitespace-nowrap">
                    {elapsed(
                      new Date(span.from).toISOString(),
                      new Date(span.to).toISOString()
                    )}
                    {span.to >= now - 1000 ? ", ongoing" : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : share !== null ? (
          <p className="text-sm text-muted-foreground">
            No outages recorded this week.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Capabilities({ printer }: { printer: PrinterDetail }) {
  const caps = printer.capabilities
  return (
    <Card>
      <CardHeader>
        <CardTitle>Capabilities</CardTitle>
      </CardHeader>
      <CardContent>
        {caps ? (
          <DetailList>
            {caps.sides.some((side) => side !== "one-sided") ? (
              <DetailRow label="Sides">
                <span className="font-normal">One- or two-sided</span>
              </DetailRow>
            ) : null}
            <DetailRow label="Paper">
              <span className="font-normal">
                {[...new Set(caps.media.map(mediaLabel))].join(", ") ||
                  "Not reported"}
              </span>
            </DetailRow>
            <DetailRow label="Colour">
              {caps.color === null ? (
                <Unavailable>Not reported</Unavailable>
              ) : caps.color ? (
                "Yes"
              ) : (
                "Black only"
              )}
            </DetailRow>
          </DetailList>
        ) : (
          <p className="text-sm text-muted-foreground">
            The printer has not reported what it supports.
          </p>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          Ink and paper levels are not shown: printers often report them
          wrongly.
        </p>
      </CardContent>
    </Card>
  )
}

/** CUPS details for troubleshooting, folded away by default. */
function TechnicalCard({ printer }: { printer: PrinterDetail }) {
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Technical</CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide" : "Show"}
          </Button>
        </CardAction>
      </CardHeader>
      {open ? (
        <CardContent className="flex flex-col gap-4">
          <DetailList>
            <DetailRow label="Accepting jobs">
              {printer.accepting === null ? (
                <Unavailable>Unknown</Unavailable>
              ) : printer.accepting ? (
                "Yes"
              ) : (
                "No"
              )}
            </DetailRow>
            {printer.capabilities?.make_model ? (
              <DetailRow label="Model">
                <span className="truncate font-normal">
                  {printer.capabilities.make_model}
                </span>
              </DetailRow>
            ) : null}
          </DetailList>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-muted-foreground">CUPS queue</p>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre">
              {printer.queue.trim() || "No jobs reported."}
            </pre>
          </div>
        </CardContent>
      ) : null}
    </Card>
  )
}

const CHECK_ICON = {
  true: <CircleCheckIcon className="size-4 text-primary" />,
  false: <CircleXIcon className="size-4 text-destructive" />,
  null: <CircleMinusIcon className="size-4 text-muted-foreground" />,
}

function CheckCard({
  check,
  onDismiss,
}: {
  check: PrinterCheckResponse
  onDismiss: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {check.ok ? "Check passed" : "The check found a problem"}
        </CardTitle>
        <CardAction className="text-sm text-muted-foreground">
          <When value={check.checked_at} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border/70">
          {check.checks.map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-2 text-sm">
              <span className="mt-0.5" aria-hidden="true">
                {CHECK_ICON[String(item.ok) as keyof typeof CHECK_ICON]}
              </span>
              <span className="flex min-w-0 flex-1 flex-wrap justify-between gap-x-4">
                <span className="font-medium">
                  {item.label}
                  <span className="sr-only">
                    {item.ok === null
                      ? ": skipped"
                      : item.ok
                        ? ": ok"
                        : ": problem"}
                  </span>
                </span>
                <span className="text-muted-foreground">{item.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          Nothing was printed.
        </span>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </CardFooter>
    </Card>
  )
}

function PrinterSkeleton() {
  return (
    <Page aria-busy="true">
      <PageHeader>
        <Skeleton className="h-7 w-56" />
      </PageHeader>
      <PageGrid layout="wide">
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-5 w-full" />
            ))}
          </CardContent>
        </Card>
      </PageGrid>
    </Page>
  )
}
