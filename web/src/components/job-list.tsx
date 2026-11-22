import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { cn, toast } from "@zsrobinson/shell"
import { ConfirmAction } from "@zsrobinson/shell/blocks/confirm-action"
import { errorMessage } from "@zsrobinson/shell/lib/api"
import { Button } from "@zsrobinson/shell/ui/button"
import { Skeleton } from "@zsrobinson/shell/ui/skeleton"
import { ChevronRightIcon } from "lucide-react"
import { cancelJob } from "@/lib/api"
import {
  canCancel,
  jobName,
  pagesLabel,
  PRINTER_LABELS,
  SOURCE_LABELS,
} from "@/lib/jobs"
import type { Job } from "@/lib/types"
import { JobIcon, JobStateBadge, When } from "./state"

const COLUMNS = "@2xl:grid-cols-[minmax(0,1fr)_7.5rem_6.5rem_7rem_4.5rem]"
const ROW = cn(
  "relative grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-2",
  COLUMNS
)

/**
 * Jobs as rows that open their detail page. Columns appear from md up; on a
 * phone the pages and time fold under the name.
 */
export function JobList({
  jobs,
  header = true,
  cancel = false,
  className,
}: {
  jobs: Job[]
  header?: boolean
  /** Offer Cancel on active rows. */
  cancel?: boolean
  className?: string
}) {
  return (
    <div className={cn("@container", className)}>
      {header ? (
        <div
          aria-hidden="true"
          className={cn(
            "hidden gap-x-4 border-b pb-2.5 text-xs font-medium text-muted-foreground @2xl:grid",
            COLUMNS
          )}
        >
          <span>Job</span>
          <span>Size</span>
          <span>Sent</span>
          <span>Status</span>
          <span className="sr-only">Actions</span>
        </div>
      ) : null}
      <ul className="divide-y">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} cancel={cancel} />
        ))}
      </ul>
    </div>
  )
}

function JobRow({ job, cancel }: { job: Job; cancel: boolean }) {
  const name = jobName(job)
  return (
    <li className={cn(ROW, "-mx-2 rounded-lg px-2 hover:bg-muted/50")}>
      <div className="row-span-2 flex min-w-0 items-center gap-3 @2xl:row-span-1">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <JobIcon printer={job.printer} kind={job.kind} />
        </span>
        <div className="min-w-0">
          <p className="flex min-w-0">
            <Link
              to="/jobs/$id"
              params={{ id: job.id }}
              className="line-clamp-2 text-sm font-medium break-words outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-3 focus-visible:after:ring-ring/50 @2xl:truncate"
            >
              {name}
            </Link>
          </p>
          <p className="truncate text-sm text-muted-foreground @max-2xl:hidden">
            {PRINTER_LABELS[job.printer]} · {SOURCE_LABELS[job.source]}
          </p>
          <p className="truncate text-sm text-muted-foreground @2xl:hidden">
            <When value={job.created_at} /> ·{" "}
            {job.printer === "receipt"
              ? `Receipt · ${SOURCE_LABELS[job.source]}`
              : typeof job.pages === "number"
                ? `${job.pages} ${job.pages === 1 ? "page" : "pages"}${job.copies > 1 ? ` ×${job.copies}` : ""}`
                : pagesLabel(job.pages, job.copies)}
          </p>
        </div>
      </div>
      <span className="text-sm tabular-nums @max-2xl:hidden">
        {pagesLabel(job.pages, job.copies)}
      </span>
      <span className="text-sm text-muted-foreground @max-2xl:hidden">
        <When value={job.created_at} />
      </span>
      <span className="col-start-2 row-start-1 justify-self-end @2xl:col-start-auto @2xl:row-start-auto @2xl:justify-self-start">
        <JobStateBadge state={job.state} dryRun={job.dry_run} />
      </span>
      <span className="relative z-10 col-start-2 flex justify-end empty:hidden @2xl:col-start-auto @2xl:empty:flex">
        {cancel && canCancel(job) ? (
          <CancelJob job={job} size="sm" variant="outline" />
        ) : (
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground @max-2xl:hidden"
          />
        )}
      </span>
    </li>
  )
}

export function CancelJob({
  job,
  size = "default",
  variant = "ghost",
}: {
  job: Job
  size?: "sm" | "default"
  variant?: "ghost" | "outline"
}) {
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => cancelJob(job.id),
    onSuccess: () => toast.success(`Cancelled ${jobName(job)}`),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  })
  return (
    <ConfirmAction
      title={`Cancel ${jobName(job)}?`}
      confirmLabel="Cancel job"
      dismissLabel="Keep job"
      destructive
      trigger={
        <Button variant={variant} size={size} disabled={cancel.isPending}>
          Cancel
        </Button>
      }
      onConfirm={() => cancel.mutateAsync()}
    >
      Pages already sent to the printer may still come out.
    </ConfirmAction>
  )
}

export function JobListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul
      className="@container divide-y"
      aria-busy="true"
      aria-label="Loading jobs"
    >
      {Array.from({ length: rows }, (_, key) => (
        <li key={key} className={ROW}>
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3.5 w-28" />
            </div>
          </div>
          <Skeleton className="h-4 w-16 @max-2xl:hidden" />
          <Skeleton className="h-4 w-14 @max-2xl:hidden" />
          <Skeleton className="h-5 w-20 justify-self-end @2xl:justify-self-start" />
          <span />
        </li>
      ))}
    </ul>
  )
}
