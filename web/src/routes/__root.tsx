import { useQuery, type QueryClient } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router"
import { AppShell, type NavGroup, type NavItem } from "@zsrobinson/shell"
import {
  NotFound,
  RouteError,
  SignedOut,
} from "@zsrobinson/shell/blocks/page-states"
import { ApiError } from "@zsrobinson/shell/lib/api"
import {
  ChartColumnIcon,
  HistoryIcon,
  PrinterIcon as PrintersIcon,
  ReceiptTextIcon,
  SendIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { AppBreadcrumbs } from "@/components/app-breadcrumbs"
import { JobIcon, PrinterIcon, StateDot } from "@/components/state"
import {
  activeJobsQuery,
  jobsQuery,
  printersQuery,
  sessionQuery,
} from "@/lib/api"
import { jobName, PRINTER_LABELS } from "@/lib/jobs"

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    loader: ({ context: { queryClient } }) => {
      // Start the frame's requests together without blocking first paint.
      void queryClient.prefetchQuery(sessionQuery)
      void queryClient.prefetchQuery(printersQuery)
    },
    component: Root,
    notFoundComponent: () => <NotFound homeLabel="Go to Print" />,
    errorComponent: RouteError,
  }
)

/** Recent jobs the command palette can jump to by name. */
const recentQuery = jobsQuery({ limit: 50 })

function Root() {
  const navigate = useNavigate()
  const pathname = useLocation({ select: (location) => location.pathname })
  const session = useQuery(sessionQuery)
  const signedOut =
    session.error instanceof ApiError && session.error.status === 401
  const active = useQuery({ ...activeJobsQuery, enabled: !signedOut })
  const printers = useQuery({ ...printersQuery, enabled: !signedOut })
  const recent = useQuery({ ...recentQuery, enabled: !signedOut })
  const activeCount = active.data?.total ?? 0
  const trouble = printers.data?.printers.some(
    (printer) => printer.state === "stopped" || printer.state === "offline"
  )
  const at = (path: string) =>
    path === "/"
      ? pathname === "/"
      : pathname === path || pathname.startsWith(`${path}/`)
  const link = (
    id: string,
    label: string,
    to: string,
    icon: ReactNode,
    extra: Partial<NavItem> = {}
  ): NavItem => ({
    id,
    label,
    icon,
    render: <Link to={to} />,
    onSelect: () => void navigate({ to }),
    active: at(to),
    ...extra,
  })

  const groups: NavGroup[] = [
    {
      id: "main",
      items: [
        link("print", "Print", "/", <SendIcon />),
        link("jobs", "Jobs", "/jobs", <HistoryIcon />, {
          badge: activeCount ? (
            <span className="tabular-nums">{activeCount}</span>
          ) : undefined,
        }),
        link("printers", "Printers", "/printers", <PrintersIcon />, {
          badge: trouble ? (
            <StateDot tone="error" className="size-1.5" />
          ) : undefined,
        }),
        link("overview", "Overview", "/overview", <ChartColumnIcon />),
      ],
    },
    {
      id: "actions",
      label: "Actions",
      hidden: true,
      items: [
        {
          ...link(
            "print-receipt",
            "Print a receipt",
            "/?printer=receipt",
            <ReceiptTextIcon />
          ),
          active: false,
          render: <Link to="/" search={{ printer: "receipt" }} />,
          onSelect: () =>
            void navigate({ to: "/", search: { printer: "receipt" } }),
        },
      ],
    },
    {
      id: "jump-printers",
      label: "Printers",
      hidden: true,
      items: (printers.data?.printers ?? []).map((printer) => ({
        ...link(
          `printer-${printer.id}`,
          `${PRINTER_LABELS[printer.id]} printer`,
          `/printers/${printer.id}`,
          <PrinterIcon printer={printer.id} />
        ),
        active: false,
      })),
    },
    {
      id: "jump-jobs",
      label: "Recent jobs",
      hidden: true,
      items: (recent.data?.jobs ?? []).map((job) => ({
        ...link(
          `job-${job.id}`,
          jobName(job),
          `/jobs/${job.id}`,
          <JobIcon printer={job.printer} kind={job.kind} />
        ),
        active: false,
      })),
    },
  ]

  return (
    <AppShell
      name="Print"
      email={session.data?.email}
      apps={session.isError ? [] : session.data?.services}
      navGroups={groups}
      searchPlaceholder="Jump to a page, printer or recent job…"
      breadcrumbs={<AppBreadcrumbs />}
    >
      {signedOut ? <SignedOut /> : <Outlet />}
    </AppShell>
  )
}
