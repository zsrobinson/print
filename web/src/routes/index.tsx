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
import { usePageTitle } from "@/lib/crumb"
import { PRINTER_LABELS } from "@/lib/jobs"
import { JOB_ID, PRINTERS, type PrinterId } from "@/lib/limits"

type PrintSearch = { printer?: "receipt"; again?: string }

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): PrintSearch => ({
    ...(search.printer === "receipt" ? { printer: "receipt" as const } : {}),
    ...(typeof search.again === "string" && JOB_ID.test(search.again)
      ? { again: search.again }
      : {}),
  }),
  staticData: { crumbs: [{ label: "Print", to: "/" }] },
  component: PrintPage,
})

function PrintPage() {
  usePageTitle("Print")
  const { printer = "document", again } = Route.useSearch()
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
              const value = values[0] as PrinterId | undefined
              if (!value || value === printer) return
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
      ) : null}
      {printer === "receipt" ? (
        <ReceiptForm
          key={`receipt-${again ?? ""}`}
          printer={current}
          disabled={missing}
          again={again}
        />
      ) : (
        <DocumentForm
          key={`document-${again ?? ""}`}
          printer={current}
          disabled={missing}
          again={again}
        />
      )}
    </Page>
  )
}
