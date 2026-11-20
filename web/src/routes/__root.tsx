import { useQuery, type QueryClient } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router"
import { AppShell, type NavItem } from "@zsrobinson/shell"
import {
  NotFound,
  RouteError,
  SignedOut,
} from "@zsrobinson/shell/blocks/page-states"
import { ApiError } from "@zsrobinson/shell/lib/api"
import {
  ChartColumnIcon,
  ListOrderedIcon,
  PrinterIcon,
  SendIcon,
} from "lucide-react"
import { StateDot } from "@/components/state"
import { jobsQuery, printersQuery, sessionQuery } from "@/lib/api"
import { isActive } from "@/lib/jobs"

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

const PAGES = [
  { to: "/", label: "Print", icon: <SendIcon /> },
  { to: "/queue", label: "Queue", icon: <ListOrderedIcon /> },
  { to: "/printers", label: "Printers", icon: <PrinterIcon /> },
  { to: "/stats", label: "Stats", icon: <ChartColumnIcon /> },
] as const

function Root() {
  const navigate = useNavigate()
  const pathname = useLocation({ select: (location) => location.pathname })
  const session = useQuery(sessionQuery)
  const signedOut =
    session.error instanceof ApiError && session.error.status === 401
  const jobs = useQuery({ ...jobsQuery, enabled: !signedOut })
  const printers = useQuery({ ...printersQuery, enabled: !signedOut })
  const active = jobs.data?.jobs.filter(isActive).length ?? 0
  const trouble = printers.data?.printers.some(
    (printer) => printer.state === "stopped" || printer.state === "offline"
  )

  const items: NavItem[] = PAGES.map((page) => ({
    id: page.to,
    label: page.label,
    icon: page.icon,
    render: <Link to={page.to} />,
    onSelect: () => void navigate({ to: page.to }),
    active: pathname === page.to,
    badge:
      page.to === "/queue" && active ? (
        <span className="tabular-nums">{active}</span>
      ) : page.to === "/printers" && trouble ? (
        <StateDot tone="error" className="size-1.5" />
      ) : undefined,
  }))

  return (
    <AppShell
      name="Print"
      email={session.data?.email}
      apps={session.isError ? [] : session.data?.services}
      navGroups={[{ id: "main", items }]}
    >
      {signedOut ? <SignedOut /> : <Outlet />}
    </AppShell>
  )
}
