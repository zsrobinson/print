import { Link } from "@tanstack/react-router"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@zsrobinson/shell/ui/alert"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@zsrobinson/shell/ui/field"
import { Switch } from "@zsrobinson/shell/ui/switch"
import { CircleCheckIcon } from "lucide-react"
import { useId } from "react"
import { PRINTER_LABELS, pagesLabel } from "@/lib/jobs"
import type { Job } from "@/lib/types"

export function DryRunField({
  checked,
  onCheckedChange,
  className,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  className?: string
}) {
  const id = useId()
  return (
    <Field orientation="horizontal" className={className}>
      <FieldContent>
        <FieldLabel htmlFor={id}>Dry run</FieldLabel>
        <FieldDescription>
          Validate and lay out the job without printing.
        </FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
  )
}

/** What the core accepted, in its own words: id, pages and whether it printed. */
export function JobResult({ job, dryRun }: { job: Job; dryRun: boolean }) {
  const printer = PRINTER_LABELS[job.printer]?.toLowerCase() ?? "selected"
  const detail = [
    job.id ? `Job ${job.id}` : null,
    typeof job.pages === "number" ? pagesLabel(job.pages, job.copies) : null,
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <Alert role="status">
      <CircleCheckIcon />
      <AlertTitle>
        {dryRun ? "Check passed" : `Sent to the ${printer} printer`}
      </AlertTitle>
      <AlertDescription>
        {detail ? `${detail}. ` : ""}
        {dryRun ? "Nothing was printed." : "Follow it in the queue."}
      </AlertDescription>
      {dryRun ? null : (
        <AlertAction>
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/queue" />}
            nativeButton={false}
          >
            View queue
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}
