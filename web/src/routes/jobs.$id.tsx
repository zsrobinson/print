import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  Page,
  PageActions,
  PageGrid,
  PageHeader,
  PageStack,
  PageTitle,
} from "@zsrobinson/shell"
import {
  DetailList,
  DetailRow,
  Unavailable,
} from "@zsrobinson/shell/blocks/detail-list"
import { QueryError } from "@zsrobinson/shell/blocks/query-error"
import { ApiError } from "@zsrobinson/shell/lib/api"
import { formatBytes } from "@zsrobinson/shell/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@zsrobinson/shell/ui/alert"
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
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@zsrobinson/shell/ui/empty"
import { Skeleton } from "@zsrobinson/shell/ui/skeleton"
import { CircleAlertIcon, DownloadIcon, RotateCcwIcon } from "lucide-react"
import { useMemo } from "react"
import { CancelJob } from "@/components/job-list"
import { PdfPages, usePdf } from "@/components/pdf-pages"
import { ReceiptPreview } from "@/components/receipt-preview"
import { JobIcon, JobStateBadge, SourceIcon, When } from "@/components/state"
import { JobTimeline } from "@/components/timeline"
import { jobQuery, keptFile } from "@/lib/api"
import { Meta } from "@/components/meta"
import { usePageTitle } from "@/lib/crumb"
import { elapsed, stamp } from "@/lib/dates"
import {
  canCancel,
  isCancelled,
  isFailed,
  jobName,
  KIND_LABELS,
  PRINTER_LABELS,
  SIDES_LABELS,
  SOURCE_LABELS,
} from "@/lib/jobs"
import { JOB_ID } from "@/lib/limits"
import { parsePages } from "@/lib/pages"
import { layoutReceipt } from "@/lib/receipt"
import type { JobDetail } from "@/lib/types"

export const Route = createFileRoute("/jobs/$id")({
  params: {
    parse: ({ id }) => ({ id: JOB_ID.test(id) ? id : "" }),
    stringify: ({ id }) => ({ id }),
  },
  staticData: { crumbs: [{ label: "Jobs", to: "/jobs" }] },
  component: JobPage,
})

function JobPage() {
  const { id } = Route.useParams()
  const job = useQuery({ ...jobQuery(id), enabled: Boolean(id) })
  const detail = job.data?.job
  usePageTitle(detail ? jobName(detail) : undefined, true)
  const missing =
    !id || (job.error instanceof ApiError && job.error.status === 404)

  if (missing)
    return (
      <Page>
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>This job is not in the history</EmptyTitle>
            <EmptyDescription>
              The link may be mistyped, or the job was never recorded.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/jobs" />} nativeButton={false}>
              Go to Jobs
            </Button>
          </EmptyContent>
        </Empty>
      </Page>
    )
  if (job.isError)
    return (
      <Page>
        <QueryError
          title="This job could not be loaded"
          error={job.error}
          onRetry={() => void job.refetch()}
        />
      </Page>
    )
  if (!detail) return <JobSkeleton />
  return <JobView job={detail} />
}

function JobView({ job }: { job: JobDetail }) {
  const name = jobName(job)
  const failed = isFailed(job.state)
  const again = job.reprintable
  return (
    <Page>
      <PageHeader className="items-start">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <PageTitle className="min-w-0 break-words">{name}</PageTitle>
            <JobStateBadge state={job.state} dryRun={job.dry_run} />
          </div>
          <Meta>
            <span className="flex items-center gap-1.5">
              <JobIcon
                printer={job.printer}
                kind={job.kind}
                className="size-3.5"
              />
              {PRINTER_LABELS[job.printer]} printer
            </span>
            <span className="flex items-center gap-1.5">
              <SourceIcon source={job.source} />
              From {SOURCE_LABELS[job.source]}
            </span>
            <span>
              Sent <When value={job.created_at} />
            </span>
          </Meta>
        </div>
        <PageActions>
          {canCancel(job) ? <CancelJob job={job} variant="outline" /> : null}
          {again ? (
            <Button
              render={
                <Link
                  to="/"
                  search={{
                    printer: job.printer === "receipt" ? "receipt" : undefined,
                    again: job.id,
                  }}
                />
              }
              nativeButton={false}
            >
              <RotateCcwIcon data-icon="inline-start" />
              {job.dry_run ? "Print for real" : "Print again"}
            </Button>
          ) : null}
        </PageActions>
      </PageHeader>

      {failed ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            {job.state === "unknown"
              ? "It is not clear whether this printed"
              : "This job did not print"}
          </AlertTitle>
          <AlertDescription>
            <p className="text-foreground">
              {job.error ??
                "The printer or CUPS stopped it before it finished."}{" "}
              <Link
                to="/printers/$id"
                params={{ id: job.printer }}
                className="underline underline-offset-4"
              >
                Check the {PRINTER_LABELS[job.printer].toLowerCase()} printer
              </Link>{" "}
              {job.reprintable
                ? "before printing it again."
                : "before trying again."}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <PageGrid layout="wide">
        <PageStack>
          <Card>
            <CardHeader>
              <CardTitle>Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <JobTimeline job={job} />
            </CardContent>
          </Card>
          <KeptCopy job={job} />
        </PageStack>
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <Details job={job} />
          </CardContent>
        </Card>
      </PageGrid>
    </Page>
  )
}

function Details({ job }: { job: JobDetail }) {
  const options = job.options ?? {}
  const total =
    typeof job.pages === "number" ? job.pages * (job.copies || 1) : null
  return (
    <DetailList>
      <DetailRow label="Printer">
        <Link
          to="/printers/$id"
          params={{ id: job.printer }}
          className="underline-offset-4 hover:underline"
        >
          {PRINTER_LABELS[job.printer]} printer
        </Link>
      </DetailRow>
      {job.printer === "document" ? (
        <>
          <DetailRow label="Pages">
            {typeof job.pages === "number" ? (
              <span>
                {job.pages}
                {job.document_pages && job.document_pages !== job.pages ? (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    of {job.document_pages}
                  </span>
                ) : null}
              </span>
            ) : (
              <Unavailable>Not recorded</Unavailable>
            )}
          </DetailRow>
          {options.page_range ? (
            <DetailRow label="Page range">
              <span className="font-mono text-xs">{options.page_range}</span>
            </DetailRow>
          ) : null}
          <DetailRow label="Copies">
            {total !== null && job.copies > 1 ? (
              <span>
                {job.copies}
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {total} pages in all
                </span>
              </span>
            ) : (
              job.copies
            )}
          </DetailRow>
          <DetailRow label="Sides">
            {options.sides ? (
              SIDES_LABELS[options.sides]
            ) : (
              <Unavailable>Not recorded</Unavailable>
            )}
          </DetailRow>
          {options.paper_size ? (
            <DetailRow label="Paper">
              {options.paper_size.length <= 2
                ? options.paper_size.toUpperCase()
                : options.paper_size[0].toUpperCase() +
                  options.paper_size.slice(1)}
            </DetailRow>
          ) : null}
          {options.color ? (
            <DetailRow label="Colour">
              {options.color === "color" ? "Colour" : "Black and white"}
            </DetailRow>
          ) : null}
        </>
      ) : null}
      {job.kind ? (
        <DetailRow label="Type">{KIND_LABELS[job.kind]}</DetailRow>
      ) : null}
      {typeof job.size_bytes === "number" ? (
        <DetailRow label="Size">{formatBytes(job.size_bytes)}</DetailRow>
      ) : null}
      {job.finished_at ? (
        <DetailRow
          label={
            isFailed(job.state)
              ? "Stopped"
              : isCancelled(job.state)
                ? "Cancelled"
                : job.dry_run
                  ? "Checked"
                  : "Finished"
          }
        >
          <span>
            {stamp(job.finished_at)}
            <span className="font-normal text-muted-foreground">
              {" "}
              · {elapsed(job.created_at, job.finished_at)}
            </span>
          </span>
        </DetailRow>
      ) : null}
      <DetailRow label="CUPS job">
        {job.cups_id ? (
          <span className="font-mono text-xs">{job.cups_id}</span>
        ) : (
          <Unavailable>{job.dry_run ? "None, dry run" : "None"}</Unavailable>
        )}
      </DetailRow>
    </DetailList>
  )
}

/** The kept original: page thumbnails or the receipt, with its expiry. */
function KeptCopy({ job }: { job: JobDetail }) {
  const expiry = job.kept_until ? new Date(job.kept_until) : null
  const until = expiry
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(expiry)
    : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Kept copy</CardTitle>
        <CardAction className="flex items-center gap-2 text-sm text-muted-foreground">
          {job.reprintable && until
            ? `Kept until ${until}`
            : job.kept_until
              ? "Expired"
              : null}
          {job.reprintable ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Download the kept copy"
              render={<a href={`/api/jobs/${job.id}/file`} download />}
              nativeButton={false}
            >
              <DownloadIcon />
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent>
        {job.reprintable ? (
          job.kind === "receipt" ? (
            <KeptReceipt text={job.receipt_text ?? ""} />
          ) : (
            <KeptDocument job={job} />
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            {job.kept_until
              ? `The copy was deleted on ${until}. Copies are kept for 7 days.`
              : "No copy was kept for this job, so it cannot be printed again from here."}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function KeptReceipt({ text }: { text: string }) {
  const layout = useMemo(() => layoutReceipt(text), [text])
  return <ReceiptPreview layout={layout} />
}

function KeptDocument({ job }: { job: JobDetail }) {
  const file = useQuery({
    queryKey: ["jobs", "file", job.id],
    queryFn: ({ signal }) => keptFile(job.id, signal),
    staleTime: Infinity,
    retry: false,
  })
  const isPdf = file.data?.type === "application/pdf" || job.kind !== "image"
  const pdf = usePdf(file.data && isPdf ? file.data : null)
  const image = useImageUrl(file.data && !isPdf ? file.data : null)
  const range = job.options?.page_range
  const selected = useMemo(
    () => (range ? (parsePages(range) ?? undefined) : undefined),
    [range]
  )
  if (file.isError)
    return (
      <p className="text-sm text-muted-foreground">
        The copy could not be loaded. It may have just expired.
      </p>
    )
  if (!file.data) return <Skeleton className="h-36 w-full" />
  if (!isPdf)
    return image ? (
      <img
        src={image}
        alt=""
        className="max-h-80 rounded-md border bg-white object-contain"
      />
    ) : null
  return (
    <div className="flex flex-col gap-2">
      <PdfPages
        state={pdf}
        label="Pages in the kept copy"
        selected={selected}
      />
      {selected ? (
        <p className="text-sm text-muted-foreground">
          Dimmed pages were outside the page range.
        </p>
      ) : null}
    </div>
  )
}

/** A data URL for an image blob; the page's CSP allows data: images only. */
function useImageUrl(blob: Blob | null) {
  const query = useQuery({
    queryKey: ["image-url", blob ? blob.size : 0, blob],
    enabled: Boolean(blob),
    staleTime: Infinity,
    queryFn: () =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob!)
      }),
  })
  return query.data ?? null
}

function JobSkeleton() {
  return (
    <Page aria-busy="true">
      <PageHeader>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
      </PageHeader>
      <PageGrid layout="wide">
        <Card>
          <CardContent className="flex flex-col gap-4">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-8 w-full" />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-3">
            {[0, 1, 2, 3, 4, 5].map((key) => (
              <Skeleton key={key} className="h-5 w-full" />
            ))}
          </CardContent>
        </Card>
      </PageGrid>
    </Page>
  )
}
