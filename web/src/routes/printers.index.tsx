import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Page, PageGrid, PageHeader, PageTitle } from "@zsrobinson/shell"
import {
  DetailList,
  DetailRow,
  Unavailable,
} from "@zsrobinson/shell/blocks/detail-list"
import { QueryError } from "@zsrobinson/shell/blocks/query-error"
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
import { ChevronRightIcon } from "lucide-react"
import { PrinterIcon, PrinterStateBadge, When } from "@/components/state"
import {
  formatShare,
  spans,
  uptime,
  UptimeLegend,
  UptimeStrip,
} from "@/components/uptime"
import { printerQuery, printersQuery } from "@/lib/api"
import { Meta } from "@/components/meta"
import { usePageTitle } from "@/lib/crumb"
import { useNow } from "@/lib/now"
import { jobName, PRINTER_LABELS } from "@/lib/jobs"
import { describeReasons } from "@/lib/reasons"
import type { Printer } from "@/lib/types"
import { capabilitySummary } from "@/lib/printers"

export const Route = createFileRoute("/printers/")({
  staticData: { crumbs: [{ label: "Printers", to: "/printers" }] },
  component: PrintersPage,
})

function PrintersPage() {
  usePageTitle("Printers")
  const printers = useQuery(printersQuery)
  const list = printers.data?.printers ?? []
  return (
    <Page>
      <PageHeader className="items-start">
        <div className="flex flex-col gap-1">
          <PageTitle>Printers</PageTitle>
          {printers.data ? (
            <Meta>
              <span>{summary(list)}</span>
            </Meta>
          ) : null}
        </div>
      </PageHeader>
      {printers.isPending ? (
        <PageGrid layout="two">
          {[0, 1].map((key) => (
            <Card key={key} aria-busy="true">
              <CardHeader>
                <Skeleton className="h-5 w-36" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </PageGrid>
      ) : printers.isError ? (
        <QueryError
          title="Printers could not be loaded"
          error={printers.error}
          onRetry={() => void printers.refetch()}
        />
      ) : (
        <PageGrid layout="two">
          {list.map((printer) => (
            <PrinterCard key={printer.id} printer={printer} />
          ))}
        </PageGrid>
      )}
    </Page>
  )
}

/** "1 printing · 1 ready", or what needs attention first. */
function summary(list: Printer[]) {
  const count = (state: Printer["state"]) =>
    list.filter((printer) => printer.state === state).length
  const down = count("stopped") + count("offline")
  const parts = [
    down ? `${down} ${down === 1 ? "needs" : "need"} attention` : null,
    count("busy") ? `${count("busy")} printing` : null,
    count("idle") ? `${count("idle")} ready` : null,
  ].filter(Boolean)
  return parts.join(" · ") || "No printers"
}

function PrinterCard({ printer }: { printer: Printer }) {
  const detail = useQuery(printerQuery(printer.id))
  const now = useNow()
  const reasons = describeReasons(printer.status?.reasons).filter(
    (r) => r.severity !== "info"
  )
  const history = detail.data?.printer.history
  const share = history
    ? uptime(spans(history, printer.state, now - 7 * 86_400_000, now))
    : null
  const label = PRINTER_LABELS[printer.id]
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PrinterIcon printer={printer.id} className="text-muted-foreground" />
          <Link
            to="/printers/$id"
            params={{ id: printer.id }}
            className="underline-offset-4 hover:underline"
          >
            {label} printer
          </Link>
        </CardTitle>
        <CardAction>
          <PrinterStateBadge state={printer.state} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {reasons.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {reasons.map((reason) => (
              <li key={reason.reason}>
                <span className="font-medium">{reason.title}.</span>{" "}
                {reason.action ? (
                  <span className="text-muted-foreground">{reason.action}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">Last 7 days</span>
            <span className="text-muted-foreground tabular-nums">
              {share === null ? "—" : `${formatShare(share)} available`}
            </span>
          </div>
          {history ? (
            <>
              <UptimeStrip history={history} current={printer.state} />
              <UptimeLegend />
            </>
          ) : (
            <Skeleton className="h-8 w-full" />
          )}
        </div>
        <DetailList>
          <DetailRow label="Last job">
            {printer.last_job ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-normal">
                  {jobName(printer.last_job)}
                </span>
                <span className="shrink-0 font-normal text-muted-foreground">
                  <When value={printer.last_job.created_at} />
                </span>
              </span>
            ) : (
              <Unavailable>None yet</Unavailable>
            )}
          </DetailRow>
          <DetailRow label="Can print">
            {printer.capabilities ? (
              <span className="truncate font-normal">
                {capabilitySummary(printer)}
              </span>
            ) : (
              <Unavailable>Not reported</Unavailable>
            )}
          </DetailRow>
        </DetailList>
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
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
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/printers/$id" params={{ id: printer.id }} />}
          nativeButton={false}
        >
          Details
          <ChevronRightIcon data-icon="inline-end" />
        </Button>
      </CardFooter>
    </Card>
  )
}
