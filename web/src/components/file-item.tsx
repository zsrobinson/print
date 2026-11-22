import { Link } from "@tanstack/react-router"
import { cn } from "@zsrobinson/shell"
import { UploadProgress } from "@zsrobinson/shell/blocks/upload-progress"
import { formatBytes } from "@zsrobinson/shell/lib/format"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@zsrobinson/shell/ui/field"
import { Input } from "@zsrobinson/shell/ui/input"
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FileTextIcon,
  XIcon,
} from "lucide-react"
import { useId } from "react"
import { pageRangeError, type DocumentType } from "@/lib/limits"
import { formatPages, parsePages } from "@/lib/pages"
import type { Job } from "@/lib/types"
import { PdfPages, usePdf } from "./pdf-pages"

export type Queued = {
  key: string
  file: File
  name: string
  type: DocumentType | null
  /** A data URL thumbnail for images. */
  preview?: string
  range: string
  /** Pages in the document once known: 1 for images. */
  pages?: number
  status: "ready" | "sending" | "sent" | "failed"
  progress?: number
  job?: Job
  error?: string
}

/** The page picker's empty selection; never sent. */
export const NONE = "0"

const TYPE_LABELS: Record<DocumentType, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
}

/** Problems that stop this file from being sent, in the words to show. */
export function fileProblem(item: Queued, limit: number) {
  if (!item.type) return "Only PDF, PNG and JPEG files can be printed."
  if (item.file.size > limit)
    return `This file is ${formatBytes(item.file.size)}; the limit is ${formatBytes(limit)}.`
  if (item.file.size === 0) return "This file is empty."
  if (item.range === NONE) return "Choose at least one page."
  const range = item.range.replace(/\s+/g, "")
  if (item.type === "application/pdf" && range) {
    const problem = pageRangeError(range)
    if (problem) return problem
    if (item.pages && !parsePages(item.range, item.pages))
      return `This PDF has ${item.pages} ${item.pages === 1 ? "page" : "pages"}.`
  }
  return null
}

/** Pages that will print from this file, once its length is known. */
export function selectedCount(item: Queued) {
  if (!item.pages) return null
  if (item.range === NONE) return 0
  if (item.type !== "application/pdf" || !item.range.trim()) return item.pages
  return parsePages(item.range, item.pages)?.size ?? null
}

export function FileItem({
  item,
  limit,
  expanded,
  onExpand,
  onChange,
  onRemove,
  disabled,
}: {
  item: Queued
  limit: number
  expanded: boolean
  onExpand: (open: boolean) => void
  onChange: (patch: Partial<Queued>) => void
  onRemove: () => void
  disabled?: boolean
}) {
  const rangeId = useId()
  const isPdf = item.type === "application/pdf"
  const pdf = usePdf(isPdf ? item.file : null, (pages) => onChange({ pages }))
  const problem = fileProblem(item, limit)
  const pages = pdf.status === "ready" ? pdf.pages : undefined
  const selected =
    isPdf && item.range.trim() && pages
      ? (parsePages(item.range, pages) ?? undefined)
      : undefined
  const count = selectedCount(item)

  const setPages = (next: Set<number>) =>
    onChange({
      range: !next.size
        ? NONE
        : pages && next.size === pages
          ? ""
          : formatPages(next),
    })
  const all = () => new Set(Array.from({ length: pages ?? 0 }, (_, i) => i + 1))

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-2xl border p-3",
        problem && item.status === "ready" && "border-destructive/60"
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {item.preview ? (
          <img
            src={item.preview}
            alt=""
            className="size-11 shrink-0 rounded-md border bg-white object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"
          >
            <FileTextIcon className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </p>
          <p className="truncate text-sm text-muted-foreground tabular-nums">
            {item.type ? TYPE_LABELS[item.type] : "Unsupported"} ·{" "}
            {formatBytes(item.file.size)}
            {isPdf && pages
              ? ` · ${count !== null && count !== pages ? `${count} of ` : ""}${pages} ${pages === 1 ? "page" : "pages"}`
              : null}
          </p>
        </div>
        <Status item={item} />
        {item.status === "ready" || item.status === "failed" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${item.name}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>

      {item.status === "sending" ? (
        <UploadProgress
          fraction={item.progress ?? 0}
          label={(item.progress ?? 0) < 1 ? "Uploading" : "Sending to CUPS"}
        />
      ) : null}
      {item.status === "failed" && item.error ? (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          {item.error}
        </p>
      ) : null}
      {problem && item.status === "ready" && !(isPdf && item.range) ? (
        <p className="text-sm text-destructive">{problem}</p>
      ) : null}

      {isPdf && item.status !== "sent" ? (
        <Field data-invalid={Boolean(problem && item.range)}>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-1 basis-40 flex-col gap-2">
              <FieldLabel htmlFor={rangeId}>Pages</FieldLabel>
              <Input
                id={rangeId}
                placeholder={
                  item.range === NONE
                    ? "No pages chosen"
                    : pages
                      ? `All ${pages} pages`
                      : "All pages"
                }
                autoComplete="off"
                spellCheck={false}
                inputMode="numeric"
                disabled={disabled}
                aria-invalid={Boolean(problem && item.range)}
                value={item.range === NONE ? "" : item.range}
                onChange={(event) => onChange({ range: event.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              aria-expanded={expanded}
              disabled={pdf.status === "error"}
              onClick={() => onExpand(!expanded)}
            >
              {expanded ? "Hide pages" : "Choose pages"}
              <ChevronDownIcon
                data-icon="inline-end"
                className={cn("transition-transform", expanded && "rotate-180")}
              />
            </Button>
          </div>
          {problem && item.range ? (
            <FieldError>{problem}</FieldError>
          ) : (
            <FieldDescription>
              Leave empty for every page, list pages like 1-3,5, or pick them
              below.
            </FieldDescription>
          )}
          {expanded ? (
            <div className="flex flex-col gap-2 pt-1">
              {pages ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => onChange({ range: "" })}
                  >
                    All
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    // An empty selection is shown as "none" until a page is picked.
                    onClick={() => onChange({ range: NONE })}
                  >
                    None
                  </Button>
                  <span className="ml-auto text-xs text-muted-foreground max-sm:hidden">
                    Shift-click to select a run of pages
                  </span>
                </div>
              ) : null}
              <PdfPages
                state={pdf}
                label={`Pages of ${item.name}`}
                selected={item.range === NONE ? new Set<number>() : selected}
                onToggle={(page) => {
                  const next =
                    item.range === NONE
                      ? new Set<number>()
                      : (selected ?? all())
                  if (next.has(page)) next.delete(page)
                  else next.add(page)
                  setPages(next)
                }}
                onSelectRun={(from, to) => {
                  const next =
                    item.range === NONE
                      ? new Set<number>()
                      : (selected ?? all())
                  const [a, b] = from < to ? [from, to] : [to, from]
                  for (let page = a; page <= b; page++) next.add(page)
                  setPages(next)
                }}
              />
            </div>
          ) : null}
        </Field>
      ) : null}
    </li>
  )
}

function Status({ item }: { item: Queued }) {
  if (item.status === "sent" && item.job)
    return (
      <Link
        to="/jobs/$id"
        params={{ id: item.job.id }}
        className="flex shrink-0 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
      >
        <CheckIcon className="size-4" aria-hidden="true" />
        {item.job.dry_run ? "Checked" : "Sent"}
      </Link>
    )
  return null
}
