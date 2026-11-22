import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@zsrobinson/shell"
import { errorMessage } from "@zsrobinson/shell/lib/api"
import { Button } from "@zsrobinson/shell/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@zsrobinson/shell/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@zsrobinson/shell/ui/field"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zsrobinson/shell/ui/dropdown-menu"
import { Spinner } from "@zsrobinson/shell/ui/spinner"
import { Textarea } from "@zsrobinson/shell/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@zsrobinson/shell/ui/tooltip"
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ChevronDownIcon,
  FileClockIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react"
import { jobQuery, jobsQuery, keptFile, submitJob } from "@/lib/api"
import { stamp } from "@/lib/dates"
import {
  draftTitle,
  listDrafts,
  readWorking,
  saveDraft,
  STARTERS,
  writeWorking,
  type Draft,
} from "@/lib/drafts"
import { jobName } from "@/lib/jobs"
import { MAX_RECEIPT_CHARACTERS } from "@/lib/limits"
import { layoutReceipt, MAX_RECEIPT_LINES } from "@/lib/receipt"
import type { Job, Printer } from "@/lib/types"
import { DryRunField, JobResult } from "./job-result"
import { PrinterNotice } from "./printer-notice"
import { ReceiptPreview } from "./receipt-preview"

const count = new Intl.NumberFormat()
const PLACEHOLDER =
  "# Errands\n## Today\n- [ ] Pick up stamps\n- [ ] Return library books\nCoffee beans | $14"

/** Markup the receipt layout understands, inserted at the cursor. */
const SNIPPETS = [
  {
    mark: "#",
    label: "Title",
    insert: "# ",
    line: true,
    help: "Bold, double size",
  },
  {
    mark: "##",
    label: "Section",
    insert: "## ",
    line: true,
    help: "Full-width inverted bar",
  },
  {
    mark: "[ ]",
    label: "Checkbox",
    insert: "- [ ] ",
    line: true,
    help: "Tick box with a hanging indent",
  },
  {
    mark: "---",
    label: "Rule",
    insert: "---\n",
    line: true,
    help: "Dashed line across the paper",
  },
  {
    mark: "|",
    label: "Right value",
    insert: " | ",
    line: false,
    help: "Text after the last | sits flush right",
  },
] as const

/** Recent receipts the print service still keeps, to reuse their text. */
const recentReceipts = jobsQuery({ printer: "receipt", limit: 20 })

export function ReceiptForm({
  printer,
  disabled,
  again,
}: {
  printer?: Printer
  disabled?: boolean
  /** A receipt job whose kept text fills the editor. */
  again?: string
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const area = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(readWorking)
  const [drafts, setDrafts] = useState<Draft[]>(listDrafts)
  const recent = useQuery(recentReceipts)
  const reusable = (recent.data?.jobs ?? [])
    .filter((job) => job.reprintable)
    .slice(0, 6)
  const prefilled = useRef<string | null>(null)
  useEffect(() => {
    if (!again || prefilled.current === again) return
    prefilled.current = again
    void queryClient.fetchQuery(jobQuery(again)).then(
      ({ job }) => {
        if (job.printer !== "receipt") return
        if (job.receipt_text) {
          setText(job.receipt_text)
          toast.success(`Loaded ${jobName(job)}`)
        } else toast.error("The kept text has expired")
      },
      (error) => toast.error(errorMessage(error))
    )
  }, [again, queryClient])

  /** Replace the editor's text, keeping what was there as a draft. */
  function load(next: string) {
    if (text.trim() && text !== next) {
      saveDraft(text)
      setDrafts(listDrafts())
    }
    setText(next)
    setResult(null)
    setTouched(false)
    requestAnimationFrame(() => area.current?.focus())
  }
  const [dryRun, setDryRun] = useState(false)
  const [pending, setPending] = useState(false)
  const [touched, setTouched] = useState(false)
  const [result, setResult] = useState<{ job: Job; dryRun: boolean } | null>(
    null
  )
  // Layout follows typing without blocking it on long receipts.
  const deferred = useDeferredValue(text)
  // An empty editor previews its placeholder, dimmed, so both sides agree.
  const layout = useMemo(
    () => layoutReceipt(deferred || PLACEHOLDER),
    [deferred]
  )
  const characters = text.length
  const empty = !text.trim()
  const error =
    characters > MAX_RECEIPT_CHARACTERS
      ? `Receipts can be up to ${count.format(MAX_RECEIPT_CHARACTERS)} characters.`
      : layout.error
        ? `${layout.error}.`
        : touched && empty
          ? "Write the receipt text first."
          : null

  useEffect(() => writeWorking(text), [text])

  function insert(snippet: (typeof SNIPPETS)[number]) {
    const node = area.current
    if (!node) return
    const { selectionStart: start, selectionEnd: end, value } = node
    const atLineStart = start === 0 || value[start - 1] === "\n"
    const content = (snippet.line && !atLineStart ? "\n" : "") + snippet.insert
    node.focus()
    node.setRangeText(content, start, end, "end")
    setText(node.value)
  }

  async function submit() {
    setTouched(true)
    if (empty || error || pending) return
    const form = new FormData()
    form.set("printer", "receipt")
    form.set("text", text)
    form.set("dry_run", String(dryRun))
    setPending(true)
    try {
      const { job } = await submitJob(form)
      setResult({ job, dryRun })
      toast.success(dryRun ? "Check passed" : "Sent to the receipt printer")
    } catch (failure) {
      toast.error(errorMessage(failure))
    } finally {
      setPending(false)
      void queryClient.invalidateQueries({ queryKey: ["jobs"] })
      void queryClient.invalidateQueries({ queryKey: ["printers"] })
    }
  }

  return (
    <form
      noValidate
      className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardContent className="flex flex-col gap-6">
            {printer ? <PrinterNotice printer={printer} /> : null}
            <Field data-invalid={Boolean(error)}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel htmlFor={id}>Text</FieldLabel>
                <div className="flex items-center gap-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={disabled || pending}
                        />
                      }
                    >
                      Start from
                      <ChevronDownIcon data-icon="inline-end" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Starters</DropdownMenuLabel>
                        {STARTERS.map((starter) => (
                          <DropdownMenuItem
                            key={starter.id}
                            onClick={() => load(starter.text)}
                          >
                            {starter.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                      {drafts.length ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>Saved drafts</DropdownMenuLabel>
                            {drafts.slice(0, 6).map((draft) => (
                              <DropdownMenuItem
                                key={draft.id}
                                onClick={() => load(draft.text)}
                              >
                                <span className="min-w-0 flex-1 truncate">
                                  {draftTitle(draft.text)}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {stamp(
                                    new Date(draft.saved_at).toISOString()
                                  )}
                                </span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
                        </>
                      ) : null}
                      {reusable.length ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>
                              Recent receipts
                            </DropdownMenuLabel>
                            {reusable.map((job) => (
                              <DropdownMenuItem
                                key={job.id}
                                onClick={() =>
                                  void keptFile(job.id)
                                    .then((blob) => blob.text())
                                    .then(load, () =>
                                      toast.error(
                                        "That receipt's text has expired"
                                      )
                                    )
                                }
                              >
                                <FileClockIcon />
                                <span className="min-w-0 flex-1 truncate">
                                  {jobName(job)}
                                </span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <div
                role="toolbar"
                aria-label="Insert formatting"
                className="-mx-1 flex flex-wrap gap-1"
              >
                {SNIPPETS.map((snippet) => (
                  <Tooltip key={snippet.label}>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={disabled || pending}
                          onClick={() => insert(snippet)}
                        />
                      }
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {snippet.mark}
                      </span>
                      {snippet.label}
                    </TooltipTrigger>
                    <TooltipContent>{snippet.help}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
              <Textarea
                id={id}
                ref={area}
                rows={14}
                spellCheck
                aria-invalid={Boolean(error)}
                disabled={disabled}
                placeholder={PLACEHOLDER}
                className="min-h-72 resize-y font-mono text-sm leading-relaxed"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              {error ? (
                <FieldError>{error}</FieldError>
              ) : (
                <FieldDescription className="tabular-nums">
                  {deferred ? layout.lines.length : 0} of {MAX_RECEIPT_LINES}{" "}
                  lines, {count.format(characters)} of{" "}
                  {count.format(MAX_RECEIPT_CHARACTERS)} characters
                </FieldDescription>
              )}
            </Field>
            <DryRunField checked={dryRun} onCheckedChange={setDryRun} />
          </CardContent>
          <CardFooter className="gap-3">
            <Button type="submit" disabled={disabled || pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              {dryRun ? "Check receipt" : "Print receipt"}
            </Button>
            {text.trim() ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    saveDraft(text)
                    setDrafts(listDrafts())
                    toast.success("Saved as a draft in this browser")
                  }}
                >
                  <SaveIcon data-icon="inline-start" />
                  Save draft
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto"
                  disabled={pending}
                  onClick={() => {
                    setText("")
                    setTouched(false)
                    setResult(null)
                    area.current?.focus()
                  }}
                >
                  <Trash2Icon data-icon="inline-start" />
                  Clear
                </Button>
              </>
            ) : null}
          </CardFooter>
        </Card>
        {result ? <JobResult job={result.job} dryRun={result.dryRun} /> : null}
      </div>
      <Card className="min-w-0 lg:sticky lg:top-16">
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardAction className="text-sm text-muted-foreground tabular-nums">
            {layout.columns} columns
          </CardAction>
        </CardHeader>
        <CardContent>
          <ReceiptPreview layout={layout} muted={!deferred} />
        </CardContent>
      </Card>
    </form>
  )
}
