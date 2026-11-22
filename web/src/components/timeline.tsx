import { cn } from "@zsrobinson/shell"
import { CheckIcon, XIcon } from "lucide-react"
import { stamp } from "@/lib/dates"
import { isCancelled, isFailed } from "@/lib/jobs"
import type { JobDetail } from "@/lib/types"

type Step = {
  key: string
  label: string
  at?: string
  status: "done" | "current" | "upcoming" | "failed"
  note?: string
}

const firstAt = (job: JobDetail, ...states: string[]) =>
  job.events.find((event) => states.includes(event.state))?.at

/**
 * Submitted, waiting, printing, then how it ended. Steps CUPS skipped past
 * between checks still count as done once a later step has happened.
 */
export function jobSteps(job: JobDetail): Step[] {
  const state = job.state.toLowerCase()
  const failed = isFailed(state)
  const cancelled = isCancelled(state)
  const ended = failed || cancelled || state === "completed"
  if (job.dry_run)
    return [
      {
        key: "submitted",
        label: "Submitted",
        at: job.created_at,
        status: "done",
      },
      {
        key: "checked",
        label: failed ? "Check failed" : "Checked",
        at: job.finished_at ?? firstAt(job, "completed") ?? job.created_at,
        status: failed ? "failed" : "done",
        note: failed
          ? undefined
          : "A dry run: nothing was sent to the printer.",
      },
    ]
  const waitingAt = firstAt(job, "pending", "held")
  const printingAt = firstAt(job, "processing")
  const printing = state === "processing"
  const waiting = ["pending", "held", "stopped"].includes(state)
  const steps: Step[] = [
    {
      key: "submitted",
      label: "Submitted",
      at: job.created_at,
      status: "done",
    },
    {
      key: "waiting",
      label:
        state === "held"
          ? "Held in the queue"
          : state === "stopped"
            ? "Waiting, printer stopped"
            : "Waiting in the queue",
      at: waitingAt,
      status: waiting ? "current" : "done",
    },
  ]
  // A job cancelled or failed before printing never reached the printer.
  const reachedPrinter =
    Boolean(printingAt) || printing || state === "completed"
  if (reachedPrinter || !ended)
    steps.push({
      key: "printing",
      label: "Printing",
      at: printingAt,
      status: printing ? "current" : ended ? "done" : "upcoming",
    })
  const end = job.finished_at ?? firstAt(job, state)
  steps.push(
    failed
      ? {
          key: "end",
          label: state === "unknown" ? "Outcome unknown" : "Failed",
          at: end,
          status: "failed",
        }
      : cancelled
        ? { key: "end", label: "Cancelled", at: end, status: "failed" }
        : {
            key: "end",
            label: "Printed",
            at: state === "completed" ? end : undefined,
            status: state === "completed" ? "done" : "upcoming",
          }
  )
  return steps
}

export function JobTimeline({ job }: { job: JobDetail }) {
  // A time equal to the step before it says nothing new, so show it once.
  const steps = jobSteps(job).map((step, index, all) => {
    const before = all
      .slice(0, index)
      .reverse()
      .find((other) => other.at)?.at
    return step.key !== "end" &&
      step.at &&
      before &&
      stamp(step.at) === stamp(before)
      ? { ...step, at: undefined }
      : step
  })
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => (
        <li key={step.key} className="relative flex gap-3 pb-5 last:pb-0">
          {index < steps.length - 1 ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-6 bottom-0 left-[0.6875rem] w-px",
                step.status === "done" ? "bg-primary/50" : "bg-border"
              )}
            />
          ) : null}
          <Marker status={step.status} />
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 pt-0.5">
            <span
              className={cn(
                "text-sm font-medium",
                step.status === "upcoming" &&
                  "font-normal text-muted-foreground"
              )}
            >
              {step.label}
              <span className="sr-only">
                {step.status === "current"
                  ? ", in progress"
                  : step.status === "upcoming"
                    ? ", not yet"
                    : ""}
              </span>
            </span>
            {step.at ? (
              <time
                dateTime={step.at}
                className="text-sm text-muted-foreground tabular-nums"
              >
                {stamp(step.at)}
              </time>
            ) : null}
            {step.note ? (
              <p className="basis-full text-sm text-muted-foreground">
                {step.note}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

function Marker({ status }: { status: Step["status"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border",
        status === "done" &&
          "border-primary bg-primary text-primary-foreground",
        status === "current" && "border-primary bg-background",
        status === "upcoming" && "border-border bg-background",
        status === "failed" && "border-destructive bg-destructive text-white"
      )}
    >
      {status === "done" ? <CheckIcon className="size-3.5" /> : null}
      {status === "failed" ? <XIcon className="size-3.5" /> : null}
      {status === "current" ? (
        <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" />
      ) : null}
    </span>
  )
}
