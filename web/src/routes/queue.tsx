import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  Page,
  PageActions,
  PageHeader,
  PageMeta,
  PageTitle,
  toast,
} from "@zsrobinson/shell"
import { ConfirmAction } from "@zsrobinson/shell/blocks/confirm-action"
import { QueryError } from "@zsrobinson/shell/blocks/query-error"
import { errorMessage } from "@zsrobinson/shell/lib/api"
import { Badge } from "@zsrobinson/shell/ui/badge"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@zsrobinson/shell/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@zsrobinson/shell/ui/empty"
import { Skeleton } from "@zsrobinson/shell/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@zsrobinson/shell/ui/toggle-group"
import { useState } from "react"
import { JobStateBadge, PrinterIcon, When } from "@/components/state"
import { cancelJob, jobsQuery } from "@/lib/api"
import {
  canCancel,
  isActive,
  pagesLabel,
  PRINTER_LABELS,
  SOURCE_LABELS,
  toMillis,
} from "@/lib/jobs"
import { PRINTERS, type PrinterId } from "@/lib/limits"
import type { Job } from "@/lib/types"

type Filter = "all" | PrinterId

export const Route = createFileRoute("/queue")({
  validateSearch: (search): { printer?: PrinterId } =>
    PRINTERS.includes(search.printer as PrinterId)
      ? { printer: search.printer as PrinterId }
      : {},
  component: QueuePage,
})

const ROW =
  "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2 md:grid-cols-[minmax(0,1fr)_7.5rem_6.5rem_6.5rem_5.5rem]"

function QueuePage() {
  const { printer } = Route.useSearch()
  const navigate = Route.useNavigate()
  const filter: Filter = printer ?? "all"
  const jobs = useQuery(jobsQuery)
  const all = [...(jobs.data?.jobs ?? [])].sort(
    (a, b) => (toMillis(b.created_at) ?? 0) - (toMillis(a.created_at) ?? 0)
  )
  const shown = all.filter((job) => filter === "all" || job.printer === filter)
  const active = shown.filter(isActive)
  const recent = shown.filter((job) => !isActive(job))

  return (
    <Page>
      <PageHeader>
        <div className="flex flex-col gap-1">
          <PageTitle>Queue</PageTitle>
          {jobs.data ? (
            <PageMeta>
              <span>{active.length} active</span>
              <span>{recent.length} recent</span>
            </PageMeta>
          ) : null}
        </div>
        <PageActions>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Printer"
            value={[filter]}
            onValueChange={(value: string[]) => {
              const next = value[0] as Filter | undefined
              if (!next) return
              void navigate({
                search: next === "all" ? {} : { printer: next },
                replace: true,
              })
            }}
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            {PRINTERS.map((id) => (
              <ToggleGroupItem key={id} value={id}>
                {PRINTER_LABELS[id]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </PageActions>
      </PageHeader>
      {jobs.isPending ? (
        <QueueSkeleton />
      ) : jobs.isError ? (
        <QueryError
          title="The queue could not be loaded"
          error={jobs.error}
          onRetry={() => void jobs.refetch()}
        />
      ) : (
        <>
          <JobList
            title="Active"
            jobs={active}
            empty={
              <p className="py-3 text-sm text-muted-foreground">
                Nothing is printing or waiting.
              </p>
            }
          />
          <JobList
            title="Recent"
            jobs={recent}
            empty={
              <Empty className="py-6">
                <EmptyHeader>
                  <EmptyTitle>No finished jobs yet</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button render={<Link to="/" />} nativeButton={false}>
                    Print something
                  </Button>
                </EmptyContent>
              </Empty>
            }
          />
          <CupsCard cups={jobs.data.cups} filter={filter} />
        </>
      )}
    </Page>
  )
}

function JobList({
  title,
  jobs,
  empty,
}: {
  title: string
  jobs: Job[]
  empty: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {title}{" "}
          <span className="font-normal text-muted-foreground tabular-nums">
            {jobs.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {jobs.length ? (
          <>
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(0,1fr)_7.5rem_6.5rem_6.5rem_5.5rem] gap-x-4 border-b pb-2.5 text-xs font-medium text-muted-foreground md:grid"
            >
              <span>Job</span>
              <span>Pages</span>
              <span>Sent</span>
              <span>Status</span>
              <span className="sr-only">Actions</span>
            </div>
            <ul className="divide-y">
              {jobs.map((job) => (
                <JobRow key={`${job.printer}:${job.id}`} job={job} />
              ))}
            </ul>
          </>
        ) : (
          empty
        )}
      </CardContent>
    </Card>
  )
}

function JobRow({ job }: { job: Job }) {
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => cancelJob(job.id),
    onSuccess: () => toast.success(`Cancelled ${job.id}`),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  })
  return (
    <li className={ROW}>
      <div className="row-span-2 flex min-w-0 items-center gap-3 md:row-span-1">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <PrinterIcon printer={job.printer} />
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            {PRINTER_LABELS[job.printer] ?? job.printer}
            {job.dry_run ? <Badge variant="secondary">Dry run</Badge> : null}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            <span className="font-mono text-xs">{job.id}</span> from{" "}
            {SOURCE_LABELS[job.source] ?? job.source}
          </p>
          <p className="text-sm text-muted-foreground tabular-nums md:hidden">
            {pagesLabel(job.pages, job.copies)}, <When value={job.created_at} />
          </p>
        </div>
      </div>
      <span className="text-sm tabular-nums max-md:hidden">
        {pagesLabel(job.pages, job.copies)}
      </span>
      <span className="text-sm text-muted-foreground max-md:hidden">
        <When value={job.created_at} />
      </span>
      <span className="col-start-2 row-start-1 justify-self-end md:col-start-auto md:row-start-auto md:justify-self-start">
        <JobStateBadge state={job.state} dryRun={job.dry_run} />
      </span>
      <span className="col-start-2 flex justify-end empty:hidden md:col-start-auto md:empty:flex">
        {canCancel(job) ? (
          <ConfirmAction
            title={`Cancel ${job.id}?`}
            confirmLabel="Cancel job"
            destructive
            trigger={
              <Button variant="ghost" size="sm" disabled={cancel.isPending}>
                Cancel
              </Button>
            }
            onConfirm={() => cancel.mutateAsync()}
          >
            Pages already sent to the printer may still come out.
          </ConfirmAction>
        ) : null}
      </span>
    </li>
  )
}

function CupsCard({
  cups,
  filter,
}: {
  cups: Partial<Record<PrinterId, string>>
  filter: Filter
}) {
  const [open, setOpen] = useState(false)
  const entries = PRINTERS.filter(
    (id) => (filter === "all" || filter === id) && id in cups
  )
  if (!entries.length) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>CUPS view</CardTitle>
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
          {entries.map((id) => (
            <div key={id} className="flex min-w-0 flex-col gap-1.5">
              <p className="text-sm font-medium">{PRINTER_LABELS[id]}</p>
              <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre">
                {cups[id]?.trim() || "No jobs reported."}
              </pre>
            </div>
          ))}
        </CardContent>
      ) : null}
    </Card>
  )
}

function QueueSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading the queue">
      <CardContent>
        <ul className="divide-y">
          {[0, 1, 2].map((key) => (
            <li key={key} className={ROW}>
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
              </div>
              <Skeleton className="h-4 w-16 max-md:hidden" />
              <Skeleton className="h-4 w-14 max-md:hidden" />
              <Skeleton className="h-5 w-20 justify-self-end md:justify-self-start" />
              <span />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
