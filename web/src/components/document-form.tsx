import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { toast } from "@zsrobinson/shell"
import { ApiError, errorMessage } from "@zsrobinson/shell/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@zsrobinson/shell/ui/alert"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@zsrobinson/shell/ui/card"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@zsrobinson/shell/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@zsrobinson/shell/ui/input-group"
import { Kbd } from "@zsrobinson/shell/ui/kbd"
import {
  NativeSelect,
  NativeSelectOption,
} from "@zsrobinson/shell/ui/native-select"
import { Spinner } from "@zsrobinson/shell/ui/spinner"
import { CircleAlertIcon, LinkIcon, MinusIcon, PlusIcon } from "lucide-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { fetchLink, jobQuery, keptFile, submitJob } from "@/lib/api"
import { jobName, SIDES_LABELS } from "@/lib/jobs"
import {
  DUPLEX,
  MAX_COPIES,
  MAX_FILE_BYTES,
  sniff,
  type Duplex,
} from "@/lib/limits"
import type { Printer } from "@/lib/types"
import { DocumentDrop } from "./document-drop"
import {
  FileItem,
  fileProblem,
  NONE,
  selectedCount,
  type Queued,
} from "./file-item"
import { DryRunField } from "./job-result"
import { PrinterNotice } from "./printer-notice"

const ACCEPT = "application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
const MAX_FILES = 20
const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

let counter = 0
async function queue(
  file: File,
  name = file.name,
  range = ""
): Promise<Queued> {
  const type = sniff(new Uint8Array(await file.slice(0, 8).arrayBuffer()))
  const item: Queued = {
    key: `file-${++counter}`,
    file,
    name: name || "Untitled",
    type,
    range,
    status: "ready",
    pages: type && type !== "application/pdf" ? 1 : undefined,
  }
  if (!type || type === "application/pdf" || file.size > MAX_FILE_BYTES)
    return item
  // The page's CSP allows data: images, not blob: URLs.
  item.preview = await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader()
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : undefined)
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(file)
  })
  return item
}

/** "report-2026.pdf" from a link, without its query string. */
function linkName(url: string) {
  try {
    const parsed = new URL(url)
    const last = decodeURIComponent(
      parsed.pathname.split("/").filter(Boolean).at(-1) ?? ""
    )
    return last || parsed.hostname
  } catch {
    return "Linked PDF"
  }
}

export function DocumentForm({
  printer,
  disabled,
  again,
}: {
  printer?: Printer
  disabled?: boolean
  /** A job whose kept copy and options prefill the form. */
  again?: string
}) {
  const queryClient = useQueryClient()
  const ids = { copies: useId(), duplex: useId(), link: useId() }
  const [items, setItems] = useState<Queued[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [copies, setCopies] = useState("1")
  const [duplex, setDuplex] = useState<Duplex>("one-sided")
  const [dryRun, setDryRun] = useState(false)
  const [pending, setPending] = useState(false)
  const [touched, setTouched] = useState(false)
  const [link, setLink] = useState("")
  const [fetching, setFetching] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [results, setResults] = useState<{
    sent: Queued[]
    dryRun: boolean
  } | null>(null)

  const add = useCallback(
    async (files: File[], names?: string[], range?: string) => {
      if (!files.length) return
      setResults(null)
      const queued = await Promise.all(
        files.map((file, index) => queue(file, names?.[index], range))
      )
      setItems((current) => {
        const next = [...current.filter((i) => i.status !== "sent"), ...queued]
        if (next.length > MAX_FILES)
          toast.error(`Up to ${MAX_FILES} files can be sent at once.`)
        const kept = next.slice(0, MAX_FILES)
        // A lone PDF opens its pages straight away.
        if (kept.length === 1 && kept[0].type === "application/pdf")
          setExpanded(kept[0].key)
        return kept
      })
    },
    []
  )

  // Paste an image (a screenshot, say) anywhere on the page.
  useEffect(() => {
    if (disabled) return
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
        /^(image\/(png|jpeg)|application\/pdf)$/.test(file.type)
      )
      if (!files.length) return
      event.preventDefault()
      const stamp = new Date().toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
      void add(
        files,
        files.map((file) =>
          file.name && file.name !== "image.png"
            ? file.name
            : `Pasted image ${stamp}.${file.type === "image/jpeg" ? "jpg" : "png"}`
        )
      )
      toast.success(
        files.length === 1
          ? "Added the pasted image"
          : `Added ${files.length} pasted files`
      )
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
  }, [add, disabled])

  // Print again: the kept original and its options, never sent automatically.
  const prefilled = useRef<string | null>(null)
  const [againError, setAgainError] = useState<string | null>(null)
  useEffect(() => {
    if (!again || prefilled.current === again) return
    prefilled.current = again
    void queryClient
      .fetchQuery(jobQuery(again))
      .then(async ({ job }) => {
        if (job.printer !== "document") return
        if (job.options?.sides) setDuplex(job.options.sides)
        setCopies(String(job.copies || 1))
        const blob = await keptFile(job.id)
        const name = jobName(job)
        const file = new File([blob], name, { type: blob.type })
        return add([file], [name], job.options?.page_range ?? "")
      })
      .catch((error) =>
        setAgainError(
          error instanceof ApiError && error.status === 404
            ? "The kept copy has expired, so this job cannot be printed again from here."
            : errorMessage(error)
        )
      )
  }, [again, add, queryClient])

  const copiesNumber = Number(copies)
  const copiesError =
    /^\d+$/.test(copies) && copiesNumber >= 1 && copiesNumber <= MAX_COPIES
      ? null
      : "Enter 1 to 100 copies."
  const ready = items.filter((item) => item.status !== "sent")
  const problems = ready.filter((item) => fileProblem(item, MAX_FILE_BYTES))
  const sides = printer?.capabilities?.sides.length
    ? DUPLEX.filter((value) => printer.capabilities!.sides.includes(value))
    : [...DUPLEX]
  // A side the chosen printer cannot do falls back to its first option.
  const sidesValue = sides.includes(duplex) ? duplex : (sides[0] ?? "one-sided")
  const pageTotal = ready.reduce(
    (sum, item) => sum + (selectedCount(item) ?? 0),
    0
  )
  const unknownPages = ready.some((item) => selectedCount(item) === null)

  const update = useCallback(
    (key: string, patch: Partial<Queued>) =>
      setItems((current) =>
        current.map((item) => (item.key === key ? { ...item, ...patch } : item))
      ),
    []
  )

  async function fetchLinked() {
    const url = link.trim()
    setLinkError(null)
    if (!/^https:\/\/\S+$/i.test(url)) {
      setLinkError("Paste a public https:// link to a PDF.")
      return
    }
    setFetching(true)
    try {
      const blob = await fetchLink(url)
      const name = linkName(url)
      await add([new File([blob], name, { type: "application/pdf" })], [name])
      setLink("")
    } catch (error) {
      setLinkError(errorMessage(error))
    } finally {
      setFetching(false)
    }
  }

  async function submit() {
    setTouched(true)
    if (!ready.length || problems.length || copiesError || pending) return
    setPending(true)
    const sent: Queued[] = []
    let failures = 0
    for (const item of ready) {
      const form = new FormData()
      form.set("printer", "document")
      form.set("file", item.file)
      form.set("name", item.name)
      form.set("copies", String(copiesNumber))
      form.set("duplex", sidesValue)
      const range = item.range.replace(/\s+/g, "")
      if (item.type === "application/pdf" && range)
        form.set("page_range", range)
      form.set("dry_run", String(dryRun))
      update(item.key, { status: "sending", progress: 0, error: undefined })
      try {
        const { job } = await submitJob(form, (progress) =>
          update(item.key, { progress })
        )
        update(item.key, { status: "sent", job })
        sent.push({ ...item, status: "sent", job })
      } catch (error) {
        failures += 1
        update(item.key, { status: "failed", error: errorMessage(error) })
        // An uncertain submission is never retried on its own.
        if (
          !(error instanceof ApiError) ||
          error.status === 0 ||
          error.status >= 500
        )
          break
      }
    }
    setPending(false)
    void queryClient.invalidateQueries({ queryKey: ["jobs"] })
    void queryClient.invalidateQueries({ queryKey: ["printers"] })
    if (sent.length) {
      setResults({ sent, dryRun })
      const what =
        sent.length === 1 ? jobName(sent[0].job!) : `${sent.length} documents`
      toast.success(dryRun ? `Checked ${what}` : `Sent ${what} to the printer`)
      if (!dryRun) {
        setItems((current) => current.filter((item) => item.status !== "sent"))
        setTouched(false)
      }
    }
    if (failures)
      toast.error(
        failures === 1
          ? "One file was not sent"
          : `${failures} files were not sent`
      )
  }

  const step = (delta: number) =>
    setCopies(
      String(Math.min(MAX_COPIES, Math.max(1, (copiesNumber || 1) + delta)))
    )
  const count = ready.length
  const label = dryRun
    ? count > 1
      ? `Check ${count} documents`
      : "Check document"
    : count > 1
      ? `Print ${count} documents`
      : "Print document"

  return (
    <form
      noValidate
      className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex min-w-0 flex-col gap-4">
        {again && againError ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>This job cannot be printed again</AlertTitle>
            <AlertDescription>{againError}</AlertDescription>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DocumentDrop
              accept={ACCEPT}
              compact={items.length > 0}
              disabled={disabled || pending}
              invalid={touched && !ready.length}
              onFiles={(files) => void add(files)}
            />
            {touched && !ready.length ? (
              <FieldError>Choose at least one file to print.</FieldError>
            ) : null}
            <Field data-invalid={Boolean(linkError)}>
              <FieldLabel htmlFor={ids.link} className="sr-only">
                Link to a PDF
              </FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <LinkIcon />
                </InputGroupAddon>
                <InputGroupInput
                  id={ids.link}
                  type="url"
                  inputMode="url"
                  placeholder="Or paste a link to a public PDF"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled || pending}
                  aria-invalid={Boolean(linkError)}
                  value={link}
                  onChange={(event) => {
                    setLink(event.target.value)
                    setLinkError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      void fetchLinked()
                    }
                  }}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    variant="secondary"
                    disabled={!link.trim() || fetching || disabled}
                    onClick={() => void fetchLinked()}
                  >
                    {fetching ? <Spinner data-icon="inline-start" /> : null}
                    Add
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {linkError ? <FieldError>{linkError}</FieldError> : null}
            </Field>
            {items.length ? (
              <ul className="flex flex-col gap-2" aria-label="Files to print">
                {items.map((item) => (
                  <FileItem
                    key={item.key}
                    item={item}
                    limit={MAX_FILE_BYTES}
                    disabled={pending}
                    expanded={expanded === item.key}
                    onExpand={(open) => setExpanded(open ? item.key : null)}
                    onChange={(patch) => update(item.key, patch)}
                    onRemove={() =>
                      setItems((current) =>
                        current.filter((i) => i.key !== item.key)
                      )
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                PDF, PNG or JPEG up to 10 MiB each, printed exactly as they are.
                <span className="[@media(pointer:coarse)]:hidden">
                  {" "}
                  Paste an image with{" "}
                  <span className="whitespace-nowrap">
                    <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd> <Kbd>V</Kbd>.
                  </span>
                </span>
              </p>
            )}
          </CardContent>
        </Card>
        {results ? <Results {...results} /> : null}
      </div>

      <Card className="lg:sticky lg:top-16">
        <CardHeader>
          <CardTitle>Options</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {printer ? <PrinterNotice printer={printer} /> : null}
          <FieldGroup className="gap-6">
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
                value={sidesValue}
                disabled={sides.length < 2}
                onChange={(event) => setDuplex(event.target.value as Duplex)}
              >
                {sides.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {SIDES_LABELS[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <DryRunField checked={dryRun} onCheckedChange={setDryRun} />
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3">
          {count ? (
            <p className="flex justify-between text-sm text-muted-foreground tabular-nums">
              <span>
                {count} {count === 1 ? "file" : "files"}
              </span>
              <span>
                {unknownPages
                  ? "Counting pages…"
                  : `${pageTotal * (copiesNumber || 1)} ${pageTotal * (copiesNumber || 1) === 1 ? "page" : "pages"}${copiesNumber > 1 ? ` (${pageTotal} × ${copiesNumber})` : ""}`}
              </span>
            </p>
          ) : null}
          {problems.length && touched ? (
            <p className="text-sm text-destructive">
              Fix the highlighted {problems.length === 1 ? "file" : "files"}{" "}
              first.
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={
              disabled || pending || problems.some((i) => i.range === NONE)
            }
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {label}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}

function Results({ sent, dryRun }: { sent: Queued[]; dryRun: boolean }) {
  return (
    <Alert role="status">
      <AlertTitle>
        {dryRun
          ? sent.length === 1
            ? "Check passed. Nothing was printed."
            : `${sent.length} checks passed. Nothing was printed.`
          : sent.length === 1
            ? "Sent to the document printer"
            : `Sent ${sent.length} documents to the printer`}
      </AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-0.5">
          {sent.map((item) =>
            item.job ? (
              <li key={item.key} className="truncate">
                <Link
                  to="/jobs/$id"
                  params={{ id: item.job.id }}
                  className="underline underline-offset-4"
                >
                  {jobName(item.job)}
                </Link>
              </li>
            ) : null
          )}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
