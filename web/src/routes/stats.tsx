import { createFileRoute, redirect } from "@tanstack/react-router"

/** The old Stats page is now Overview; keep links and bookmarks working. */
export const Route = createFileRoute("/stats")({
  beforeLoad: () => {
    throw redirect({ to: "/overview", replace: true })
  },
})
