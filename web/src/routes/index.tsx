import { useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Page, PageActions, PageHeader, PageTitle } from "@zsrobinson/shell"
import { Alert, AlertDescription, AlertTitle } from "@zsrobinson/shell/ui/alert"
import { Tabs, TabsList, TabsTrigger } from "@zsrobinson/shell/ui/tabs"
import { CircleAlertIcon } from "lucide-react"
import { DocumentForm } from "@/components/document-form"
import { ReceiptForm } from "@/components/receipt-form"
import { PrinterIcon, StateDot } from "@/components/state"
import { printersQuery } from "@/lib/api"
import { PRINTER_LABELS, PRINTER_STATE } from "@/lib/jobs"
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
          <Tabs
            value={printer}
            onValueChange={(value) =>
              void navigate({
                search: value === "receipt" ? { printer: "receipt" } : {},
                replace: true,
              })
            }
          >
            <TabsList aria-label="Printer">
              {PRINTERS.map((id) => {
                const state = printers.data?.printers.find(
                  (p) => p.id === id
                )?.state
                return (
                  <TabsTrigger key={id} value={id} className="px-3">
                    <PrinterIcon printer={id} />
                    {PRINTER_LABELS[id]}
                    {state ? (
                      <StateDot
                        tone={PRINTER_STATE[state]?.tone ?? "off"}
                        className="size-1.5"
                      />
                    ) : null}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
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
        <div className="w-full max-w-3xl">
          <DocumentForm key="document" disabled={missing} />
        </div>
      )}
    </Page>
  )
}
