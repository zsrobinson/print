import { createFileRoute, redirect } from "@tanstack/react-router"
import { PRINTERS, type PrinterId } from "@/lib/limits"

/** The old Queue page is now Jobs; keep links and bookmarks working. */
export const Route = createFileRoute("/queue")({
  beforeLoad: ({ search }) => {
    const printer = (search as { printer?: unknown }).printer
    throw redirect({
      to: "/jobs",
      search: PRINTERS.includes(printer as PrinterId)
        ? { printer: printer as PrinterId }
        : {},
      replace: true,
    })
  },
})
