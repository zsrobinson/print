import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Page, PageActions, PageHeader, PageTitle } from "@zsrobinson/shell"
import { QueryError } from "@zsrobinson/shell/blocks/query-error"
import { pluralize } from "@zsrobinson/shell/lib/format"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@zsrobinson/shell/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@zsrobinson/shell/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@zsrobinson/shell/ui/input-group"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { JobList, JobListSkeleton } from "@/components/job-list"
import { Choice, DatePicker } from "@/components/pickers"
import { activeJobsQuery, jobsQuery } from "@/lib/api"
import { Meta } from "@/components/meta"
import { usePageTitle } from "@/lib/crumb"
import { ISO_DATE } from "@/lib/dates"
import {
  PRINTER_LABELS,
  SOURCE_LABELS,
  STATUS_FILTERS,
  type StatusFilter,
} from "@/lib/jobs"
import { PRINTERS, type PrinterId } from "@/lib/limits"
import type { JobSource, JobsQuery } from "@/lib/types"

type JobsSearch = {
  q?: string
  printer?: PrinterId
  status?: StatusFilter
  source?: JobSource
  dry?: "real" | "dry"
  from?: string
  to?: string
  page?: number
}

const pick = <T extends string>(value: unknown, options: readonly T[]) =>
  options.includes(value as T) ? (value as T) : undefined

export const Route = createFileRoute("/jobs/")({
  validateSearch: (search: Record<string, unknown>): JobsSearch => {
    const page = Number(search.page)
    const text = typeof search.q === "string" ? search.q.slice(0, 100) : ""
    const date = (value: unknown) =>
      typeof value === "string" && ISO_DATE.test(value) ? value : undefined
    return {
      q: text || undefined,
      printer: pick(search.printer, PRINTERS),
      status: pick(
        search.status,
        Object.keys(STATUS_FILTERS) as StatusFilter[]
      ),
      source: pick(search.source, ["web", "mcp"] as const),
      dry: pick(search.dry, ["real", "dry"] as const),
      from: date(search.from),
      to: date(search.to),
      page: Number.isInteger(page) && page > 1 ? page : undefined,
    }
  },
  staticData: { crumbs: [{ label: "Jobs", to: "/jobs" }] },
  component: JobsPage,
})

const PAGE_SIZE = 25

function JobsPage() {
  usePageTitle("Jobs")
  const s = Route.useSearch()
  const navigate = Route.useNavigate()
  const set = (patch: Partial<JobsSearch>) =>
    void navigate({
      search: (prev) => ({ ...prev, page: undefined, ...patch }),
      replace: true,
    })
  const [text, setText] = useState(s.q ?? "")
  useEffect(() => {
    const id = setTimeout(() => {
      if ((s.q ?? "") !== text.trim()) set({ q: text.trim() || undefined })
    }, 250)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])
  const advanced = Boolean(s.source || s.dry || s.from || s.to)
  const [filtersOpen, setFiltersOpen] = useState(advanced)

  const page = s.page ?? 1
  const params: JobsQuery = {
    q: s.q,
    printer: s.printer,
    // History is what has finished; Active jobs have their own card above.
    status: s.status ?? "finished",
    source: s.source,
    dry_run: s.dry ? s.dry === "dry" : undefined,
    from: s.from,
    to: s.to,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  }
  const list = useQuery(jobsQuery(params))
  const active = useQuery(activeJobsQuery)
  const filtered = Object.entries(s).some(
    ([key, value]) => value !== undefined && key !== "page"
  )
  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const activeJobs = (active.data?.jobs ?? []).filter(
    (job) => !s.printer || job.printer === s.printer
  )
  const showActive = !s.status && !s.q
  // Nothing to search until something has been printed.
  const showFilters = filtered || (list.data?.total ?? 0) > 0

  return (
    <Page>
      <PageHeader>
        <div className="flex flex-col gap-1">
          <PageTitle>Jobs</PageTitle>
          {list.data ? (
            <Meta>
              <span>
                {activeJobs.length
                  ? `${activeJobs.length} active`
                  : "Nothing printing"}
              </span>
              <span className="tabular-nums">
                {filtered
                  ? `${pluralize(total, "match", "matches")}`
                  : pluralize(total, "job")}
              </span>
            </Meta>
          ) : null}
        </div>
        <PageActions>
          <Button render={<Link to="/" />} nativeButton={false}>
            Print
          </Button>
        </PageActions>
      </PageHeader>

      {showActive && activeJobs.length ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Active{" "}
              <span className="font-normal text-muted-foreground tabular-nums">
                {activeJobs.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <JobList jobs={activeJobs} cancel header={false} />
          </CardContent>
        </Card>
      ) : null}

      {list.isError ? (
        <QueryError
          title="Jobs could not be loaded"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {s.status === "active" ? "Active" : "History"}
            </CardTitle>
          </CardHeader>
          {showFilters ? (
            <CardContent className="-mt-1 pb-1">
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <InputGroup className="min-w-0 basis-full sm:flex-1 sm:basis-56">
                    <InputGroupAddon>
                      <SearchIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-label="Search jobs by name"
                      placeholder="Search by name"
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                  </InputGroup>
                  <Choice
                    aria-label="Printer"
                    className="min-w-0 flex-1 sm:w-40 sm:flex-none"
                    value={s.printer ?? ""}
                    placeholder="All printers"
                    onChange={(value) =>
                      set({
                        printer: (value || undefined) as PrinterId | undefined,
                      })
                    }
                    options={PRINTERS.map((id) => ({
                      value: id,
                      label: PRINTER_LABELS[id],
                    }))}
                  />
                  <Choice
                    aria-label="Status"
                    className="min-w-0 flex-1 sm:w-40 sm:flex-none"
                    value={s.status ?? ""}
                    placeholder="Any status"
                    onChange={(value) =>
                      set({
                        status: (value || undefined) as
                          StatusFilter | undefined,
                      })
                    }
                    options={Object.entries(STATUS_FILTERS).map(
                      ([value, label]) => ({
                        value,
                        label,
                      })
                    )}
                  />
                  <Button
                    variant={filtersOpen ? "secondary" : "outline"}
                    aria-expanded={filtersOpen}
                    onClick={() => setFiltersOpen((open) => !open)}
                  >
                    <SlidersHorizontalIcon data-icon="inline-start" />
                    <span className="max-sm:sr-only">Filters</span>
                  </Button>
                </div>
                {filtersOpen ? (
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <Choice
                      aria-label="Sent from"
                      className="sm:w-40"
                      value={s.source ?? ""}
                      placeholder="Web and Claude"
                      onChange={(value) =>
                        set({
                          source: (value || undefined) as JobSource | undefined,
                        })
                      }
                      options={(["web", "mcp"] as const).map((id) => ({
                        value: id,
                        label: `From ${SOURCE_LABELS[id]}`,
                      }))}
                    />
                    <Choice
                      aria-label="Dry runs"
                      className="sm:w-44"
                      value={s.dry ?? ""}
                      placeholder="With dry runs"
                      onChange={(value) =>
                        set({ dry: (value || undefined) as JobsSearch["dry"] })
                      }
                      options={[
                        { value: "real", label: "Real jobs only" },
                        { value: "dry", label: "Dry runs only" },
                      ]}
                    />
                    <DatePicker
                      aria-label="From date"
                      placeholder="From"
                      className="sm:w-44"
                      value={s.from ?? ""}
                      onChange={(value) => set({ from: value || undefined })}
                    />
                    <DatePicker
                      aria-label="To date"
                      placeholder="To"
                      className="sm:w-44"
                      value={s.to ?? ""}
                      onChange={(value) => set({ to: value || undefined })}
                    />
                  </div>
                ) : null}
                {filtered ? (
                  <div>
                    <Button
                      variant="link"
                      size="xs"
                      className="px-0"
                      onClick={() => {
                        setText("")
                        void navigate({ search: {}, replace: true })
                      }}
                    >
                      <XIcon data-icon="inline-start" />
                      Clear filters
                    </Button>
                  </div>
                ) : null}
              </div>
            </CardContent>
          ) : null}
          <CardContent>
            {!list.data ? (
              <JobListSkeleton rows={6} />
            ) : list.data.jobs.length ? (
              <JobList jobs={list.data.jobs} cancel />
            ) : filtered ? (
              <Empty className="py-8">
                <EmptyHeader>
                  <EmptyTitle>No jobs match</EmptyTitle>
                  <EmptyDescription>
                    Change the search or clear the filters.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Empty className="py-8">
                <EmptyHeader>
                  <EmptyTitle>Nothing printed yet</EmptyTitle>
                  <EmptyDescription>
                    Documents and receipts you send appear here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
          {pages > 1 ? (
            <div className="flex items-center justify-between border-t px-5 pt-3 text-sm">
              <span className="text-muted-foreground tabular-nums">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)}{" "}
                of {total}
              </span>
              <div className="flex gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Previous page"
                  disabled={page <= 1}
                  onClick={() =>
                    void navigate({
                      search: (prev) => ({
                        ...prev,
                        page: page - 1 > 1 ? page - 1 : undefined,
                      }),
                    })
                  }
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Next page"
                  disabled={page >= pages}
                  onClick={() =>
                    void navigate({
                      search: (prev) => ({ ...prev, page: page + 1 }),
                    })
                  }
                >
                  <ChevronRightIcon />
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      )}
    </Page>
  )
}
