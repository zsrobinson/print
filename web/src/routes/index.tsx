import { useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Page, PageActions, PageHeader, PageTitle } from "@zsrobinson/shell"
import { Alert, AlertDescription, AlertTitle } from "@zsrobinson/shell/ui/alert"
import { ToggleGroup, ToggleGroupItem } from "@zsrobinson/shell/ui/toggle-group"
import { CircleAlertIcon } from "lucide-react"
import { DocumentForm } from "@/components/document-form"
import { ReceiptForm } from "@/components/receipt-form"
import { PrinterIcon } from "@/components/state"
import { printersQuery } from "@/lib/api"
import { PRINTER_LABELS } from "@/lib/jobs"
import { PRINTERS, type PrinterId } from "@/lib/limits"

export const Route = createFileRoute("/")({
  validateSearch: (search): { printer?: PrinterId } =>
    search.printer === "receipt" ? { printer: "receipt" } : {},
  component: PrintPage,
})

function PrintPage() {
  const { printer = "document" } = Route.useSearch()
  const navigate = useNavigate({ from: "/" })
  const printers = useQuery(printersQuery)
  const current = printers.data?.printers.find((p) => p.id === printer)
  const missing = printers.isSuccess && !current

  return (
    <Page>
      <PageHeader>
        <PageTitle>Print</PageTitle>
        <PageActions>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Printer"
            value={[printer]}
            onValueChange={(values: string[]) => {
              const value = values[0]
              if (!value) return
              void navigate({
                search: value === "receipt" ? { printer: "receipt" } : {},
                replace: true,
              })
            }}
          >
            {PRINTERS.map((id) => (
              <ToggleGroupItem key={id} value={id}>
                <PrinterIcon printer={id} />
                {PRINTER_LABELS[id]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </PageActions>
      </PageHeader>
      {missing ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            The {PRINTER_LABELS[printer].toLowerCase()} printer is not set up
          </AlertTitle>
          <AlertDescription>
            The print service does not list it, so jobs cannot be sent.
          </AlertDescription>
        </Alert>
      ) : current &&
        (current.state === "offline" || current.state === "stopped") ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>
            The {PRINTER_LABELS[printer].toLowerCase()} printer is{" "}
            {current.state === "offline" ? "offline" : "stopped"}
          </AlertTitle>
          <AlertDescription>
            Jobs wait in the queue until it is back. Dry runs still work.
          </AlertDescription>
        </Alert>
      ) : null}
      {printer === "receipt" ? (
        <ReceiptForm key="receipt" disabled={missing} />
      ) : (
        <DocumentForm key="document" disabled={missing} />
      )}
    </Page>
  )
}
