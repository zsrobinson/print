import { Link } from "@tanstack/react-router"
import { Alert, AlertDescription, AlertTitle } from "@zsrobinson/shell/ui/alert"
import { CircleAlertIcon } from "lucide-react"
import { PRINTER_LABELS } from "@/lib/jobs"
import { describeReasons } from "@/lib/reasons"
import type { Printer } from "@/lib/types"
import { PrinterIcon, PrinterStateBadge } from "./state"

/**
 * Which printer the form sends to and whether it is ready. A stopped or
 * offline printer is called out on the form itself, with its first reason.
 */
export function PrinterNotice({ printer }: { printer: Printer }) {
  const label = PRINTER_LABELS[printer.id]
  const down = printer.state === "offline" || printer.state === "stopped"
  const reason = describeReasons(printer.status?.reasons).find(
    (r) => r.severity !== "info"
  )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <Link
          to="/printers/$id"
          params={{ id: printer.id }}
          className="flex min-w-0 items-center gap-2 font-medium underline-offset-4 hover:underline"
        >
          <PrinterIcon printer={printer.id} className="text-muted-foreground" />
          {label} printer
        </Link>
        <PrinterStateBadge state={printer.state} />
      </div>
      {down || printer.accepting === false ? (
        <Alert
          variant={printer.state === "stopped" ? "destructive" : "default"}
        >
          <CircleAlertIcon />
          <AlertTitle>
            {printer.accepting === false && !down
              ? "Not accepting jobs"
              : printer.state === "offline"
                ? "The printer is offline"
                : "The printer is stopped"}
          </AlertTitle>
          <AlertDescription>
            {reason ? `${reason.title}. ` : null}
            Jobs wait in the queue until it is back. Dry runs still work.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
