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
import { jobName, PRINTER_LABELS, pagesLabel } from "@/lib/jobs"
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

/** What the core accepted, with a link to follow the job. */
export function JobResult({ job, dryRun }: { job: Job; dryRun: boolean }) {
  const printer = PRINTER_LABELS[job.printer]?.toLowerCase() ?? "selected"
  return (
    <Alert role="status">
      <CircleCheckIcon />
      <AlertTitle>
        {dryRun ? "Check passed" : `Sent to the ${printer} printer`}
      </AlertTitle>
      <AlertDescription>
        {jobName(job)}
        {typeof job.pages === "number" && job.printer === "document"
          ? `, ${pagesLabel(job.pages, job.copies)}`
          : ""}
        . {dryRun ? "Nothing was printed." : null}
      </AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/jobs/$id" params={{ id: job.id }} />}
          nativeButton={false}
        >
          {dryRun ? "Details" : "Follow it"}
        </Button>
      </AlertAction>
    </Alert>
  )
}
