import { jobIdLabel } from "@/lib/jobs"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  Page,
  PageGrid,
  PageHeader,
  PageMeta,
  PageTitle,
} from "@zsrobinson/shell"
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
import { Separator } from "@zsrobinson/shell/ui/separator"
import { Skeleton } from "@zsrobinson/shell/ui/skeleton"
import {
  JobStateBadge,
  PrinterIcon,
  PrinterStateBadge,
  When,
} from "@/components/state"
import { printersQuery } from "@/lib/api"
import { pagesLabel, PRINTER_LABELS, PRINTER_STATE } from "@/lib/jobs"
import type { Printer, PrinterStatus } from "@/lib/types"

export const Route = createFileRoute("/printers")({ component: PrintersPage })

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null
const first = (source: Record<string, unknown>, keys: string[]) =>
  keys
    .map((key) => source[key])
    .find((value) => value !== undefined && value !== null)

/** Ink, toner and media reports are deliberately left out: they are unreliable. */
const SUPPLY = /^(marker|toner|ink|media|cover|input-tray|output-tray)/i

function reasons(status: PrinterStatus) {
  const values = Array.isArray(status.reasons)
    ? status.reasons
    : Array.isArray(status.state_reasons)
      ? status.state_reasons
      : []
  return values
    .map((value) =>
      typeof value === "string"
        ? value
        : value && typeof value === "object" && "reason" in value
          ? String((value as { reason: unknown }).reason)
          : ""
    )
    .map((value) => value.trim())
    .filter((value) => value && value !== "none" && !SUPPLY.test(value))
}

function PrintersPage() {
  const printers = useQuery(printersQuery)
  const list = printers.data?.printers ?? []
  const ready = list.filter(
    (p) => p.state === "idle" || p.state === "busy"
  ).length
  return (
    <Page>
      <PageHeader>
        <div className="flex flex-col gap-1">
          <PageTitle>Printers</PageTitle>
          {printers.data ? (
            <PageMeta>
              <span>
                {ready} of {list.length} ready
              </span>
            </PageMeta>
          ) : null}
        </div>
      </PageHeader>
      {printers.isPending ? (
        <PageGrid layout="two">
          {[0, 1].map((key) => (
            <Card key={key} aria-busy="true">
              <CardHeader>
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="h-4 w-full" />
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

function PrinterCard({ printer }: { printer: Printer }) {
  const status = printer.status ?? {}
  const message = text(
    first(status, ["message", "printer_state_message", "state_message"])
  )
  const notes = reasons(status)
  const accepting = first(status, ["accepting", "accepting_jobs"])
  const checked = first(status, ["queried_at", "checked_at", "updated_at"])
  const label = PRINTER_LABELS[printer.id] ?? printer.id
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PrinterIcon printer={printer.id} className="text-muted-foreground" />
          {label} printer
        </CardTitle>
        <CardAction>
          <PrinterStateBadge state={printer.state} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
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
          {notes.length ? (
            <DetailRow label="Reported">
              <span className="flex flex-wrap justify-end gap-1">
                {notes.map((note) => (
                  <code
                    key={note}
                    className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-normal"
                  >
                    {note}
                  </code>
                ))}
              </span>
            </DetailRow>
          ) : null}
          {typeof accepting === "boolean" ? (
            <DetailRow label="Accepting jobs">
              {accepting ? "Yes" : "No"}
            </DetailRow>
          ) : null}
          {checked !== undefined ? (
            <DetailRow label="Checked">
              <When value={checked} />
            </DetailRow>
          ) : null}
        </DetailList>
        <Separator />
        <LastResult job={printer.last_job} />
      </CardContent>
      <CardFooter className="gap-2">
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
          render={<Link to="/queue" search={{ printer: printer.id }} />}
          nativeButton={false}
        >
          Open queue
        </Button>
      </CardFooter>
    </Card>
  )
}

function LastResult({ job }: { job: Record<string, unknown> | null }) {
  if (!job)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Last result</p>
        <p className="text-sm text-muted-foreground">No jobs yet.</p>
      </div>
    )
  const state = text(job.state) ?? "unknown"
  const problem = text(first(job, ["error", "message", "reason"]))
  const pages = typeof job.pages === "number" ? job.pages : null
  const copies = typeof job.copies === "number" ? job.copies : 1
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">Last result</p>
      <DetailList>
        <DetailRow label="Job">
          <span className="font-mono text-xs">{jobIdLabel(job)}</span>
        </DetailRow>
        <DetailRow label="Result">
          <JobStateBadge state={state} dryRun={job.dry_run === true} />
        </DetailRow>
        <DetailRow label="Pages">
          {pages === null ? <Unavailable /> : pagesLabel(pages, copies)}
        </DetailRow>
        <DetailRow label="Sent">
          <When value={first(job, ["created_at", "submitted_at"])} />
        </DetailRow>
        {problem ? (
          <DetailRow label="Detail">
            <span className="truncate font-normal">{problem}</span>
          </DetailRow>
        ) : null}
      </DetailList>
    </div>
  )
}
