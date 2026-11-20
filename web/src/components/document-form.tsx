import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { toast } from "@zsrobinson/shell"
import { FileDrop } from "@zsrobinson/shell/blocks/file-drop"
import { UploadProgress } from "@zsrobinson/shell/blocks/upload-progress"
import { errorMessage } from "@zsrobinson/shell/lib/api"
import { formatBytes } from "@zsrobinson/shell/lib/format"
import { Button } from "@zsrobinson/shell/ui/button"
import { Card, CardContent, CardFooter } from "@zsrobinson/shell/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@zsrobinson/shell/ui/field"
import { Input } from "@zsrobinson/shell/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@zsrobinson/shell/ui/input-group"
import {
  NativeSelect,
  NativeSelectOption,
} from "@zsrobinson/shell/ui/native-select"
import { Spinner } from "@zsrobinson/shell/ui/spinner"
import { MinusIcon, PlusIcon, XIcon } from "lucide-react"
import { useId, useState } from "react"
import { submitJob } from "@/lib/api"
import {
  DUPLEX,
  MAX_COPIES,
  MAX_FILE_BYTES,
  pageRangeError,
  sniff,
  type DocumentType,
  type Duplex,
} from "@/lib/limits"
import type { Job } from "@/lib/types"
import { DryRunField, JobResult } from "./job-result"

const DUPLEX_LABELS: Record<Duplex, string> = {
  "one-sided": "One-sided",
  "two-sided-long-edge": "Two-sided, flip on long edge",
  "two-sided-short-edge": "Two-sided, flip on short edge",
}
const TYPE_LABELS: Record<DocumentType, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
}

type Picked = { file: File; type: DocumentType | null; preview?: string }

async function inspect(file: File): Promise<Picked> {
  const type = sniff(new Uint8Array(await file.slice(0, 8).arrayBuffer()))
  if (!type || type === "application/pdf" || file.size > MAX_FILE_BYTES)
    return { file, type }
  // The page's CSP allows data: images, not blob: URLs.
  const preview = await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader()
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : undefined)
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(file)
  })
  return { file, type, preview }
}

export function DocumentForm({ disabled }: { disabled?: boolean }) {
  const queryClient = useQueryClient()
  const ids = { copies: useId(), duplex: useId(), pages: useId() }
  const [picked, setPicked] = useState<Picked | null>(null)
  const [copies, setCopies] = useState("1")
  const [duplex, setDuplex] = useState<Duplex>("one-sided")
  const [pages, setPages] = useState("")
  const [dryRun, setDryRun] = useState(false)
  const [progress, setProgress] = useState(0)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{ job: Job; dryRun: boolean } | null>(
    null
  )
  const [touched, setTouched] = useState(false)

  const fileError = !picked
    ? null
    : !picked.type
      ? "Choose a PDF, PNG or JPEG file."
      : picked.file.size > MAX_FILE_BYTES
        ? `This file is ${formatBytes(picked.file.size)}; the limit is 10 MiB.`
        : null
  const copiesNumber = Number(copies)
  const copiesError =
    /^\d+$/.test(copies) && copiesNumber >= 1 && copiesNumber <= MAX_COPIES
      ? null
      : "Enter 1 to 100 copies."
  const pagesError = pages.trim() ? pageRangeError(pages.trim()) : null
  const isPdf = picked?.type === "application/pdf"
  const ready = picked && !fileError && !copiesError && !pagesError

  async function submit() {
    setTouched(true)
    if (!ready || pending) return
    const form = new FormData()
    form.set("printer", "document")
    form.set("file", picked.file)
    form.set("copies", String(copiesNumber))
    form.set("duplex", duplex)
    if (isPdf && pages.trim()) form.set("page_range", pages.trim())
    form.set("dry_run", String(dryRun))
    setPending(true)
    setProgress(0)
    try {
      const { job } = await submitJob(form, setProgress)
      setResult({ job, dryRun })
      toast.success(dryRun ? "Check passed" : "Sent to the document printer")
      if (!dryRun) {
        setPicked(null)
        setPages("")
        setTouched(false)
      }
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
      void queryClient.invalidateQueries({ queryKey: ["jobs"] })
      void queryClient.invalidateQueries({ queryKey: ["printers"] })
    }
  }

  const step = (delta: number) =>
    setCopies(
      String(Math.min(MAX_COPIES, Math.max(1, (copiesNumber || 1) + delta)))
    )

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Card>
        <CardContent className="flex flex-col gap-6">
          <Field data-invalid={Boolean(fileError || (touched && !picked))}>
            {picked ? (
              <div className="flex min-h-16 items-center gap-3 rounded-2xl border px-3 py-2">
                {picked.preview ? (
                  <img
                    src={picked.preview}
                    alt=""
                    className="size-12 shrink-0 rounded-md border object-cover"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-12 shrink-0 items-center justify-center rounded-md border bg-muted font-mono text-xs text-muted-foreground"
                  >
                    {picked.type === "application/pdf" ? "PDF" : "?"}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {picked.file.name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {picked.type ? TYPE_LABELS[picked.type] : "Unsupported"},{" "}
                    {formatBytes(picked.file.size)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove file"
                  disabled={pending}
                  onClick={() => {
                    setPicked(null)
                    setPages("")
                  }}
                >
                  <XIcon />
                </Button>
              </div>
            ) : (
              <FileDrop
                accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
                file={null}
                label="Choose a PDF or image"
                invalid={touched && !picked}
                disabled={disabled || pending}
                onFile={(file) => {
                  setResult(null)
                  if (file) void inspect(file).then(setPicked)
                }}
              />
            )}
            {fileError ? (
              <FieldError>{fileError}</FieldError>
            ) : touched && !picked ? (
              <FieldError>Choose a file to print.</FieldError>
            ) : (
              <FieldDescription>
                PDF, PNG or JPEG up to 10 MiB, sent exactly as uploaded.
              </FieldDescription>
            )}
          </Field>

          <FieldGroup className="grid gap-x-4 gap-y-6 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <Field data-invalid={Boolean(copiesError)}>
              <FieldLabel htmlFor={ids.copies}>Copies</FieldLabel>
              <InputGroup>
                <InputGroupAddon align="inline-start">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Fewer copies"
                    disabled={copiesNumber <= 1}
                    onClick={() => step(-1)}
                  >
                    <MinusIcon />
                  </InputGroupButton>
                </InputGroupAddon>
                <InputGroupInput
                  id={ids.copies}
                  inputMode="numeric"
                  className="text-center tabular-nums"
                  value={copies}
                  aria-invalid={Boolean(copiesError)}
                  onChange={(event) =>
                    setCopies(event.target.value.replace(/\D/g, "").slice(0, 3))
                  }
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="More copies"
                    disabled={copiesNumber >= MAX_COPIES}
                    onClick={() => step(1)}
                  >
                    <PlusIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {copiesError ? <FieldError>{copiesError}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={ids.duplex}>Sides</FieldLabel>
              <NativeSelect
                id={ids.duplex}
                className="w-full"
                value={duplex}
                onChange={(event) => setDuplex(event.target.value as Duplex)}
              >
                {DUPLEX.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {DUPLEX_LABELS[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field
              data-invalid={Boolean(pagesError)}
              data-disabled={!isPdf}
              className="sm:col-span-2"
            >
              <FieldLabel htmlFor={ids.pages}>Pages</FieldLabel>
              <Input
                id={ids.pages}
                placeholder={isPdf ? "All pages" : "Whole image"}
                autoComplete="off"
                spellCheck={false}
                disabled={!isPdf}
                aria-invalid={Boolean(pagesError)}
                value={pages}
                onChange={(event) => setPages(event.target.value)}
              />
              {pagesError ? (
                <FieldError>{pagesError}</FieldError>
              ) : (
                <FieldDescription>
                  {isPdf
                    ? "Leave empty for all pages, or list them like 1-3,5."
                    : "Page ranges apply to PDFs."}
                </FieldDescription>
              )}
            </Field>
            <DryRunField
              className="sm:col-span-2"
              checked={dryRun}
              onCheckedChange={setDryRun}
            />
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-wrap gap-3">
          <Button type="submit" disabled={disabled || pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {dryRun ? "Check document" : "Print document"}
          </Button>
          {pending && picked ? (
            <div className="min-w-40 flex-1">
              <UploadProgress
                fraction={progress}
                label={progress < 1 ? "Uploading" : "Preparing"}
              />
            </div>
          ) : (
            <Button
              variant="ghost"
              render={<Link to="/queue" />}
              nativeButton={false}
            >
              Open queue
            </Button>
          )}
        </CardFooter>
      </Card>
      {result ? <JobResult job={result.job} dryRun={result.dryRun} /> : null}
    </form>
  )
}
