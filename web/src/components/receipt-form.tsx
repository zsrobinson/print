import { useQueryClient } from "@tanstack/react-query"
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
import { submitJob } from "@/lib/api"
import { MAX_RECEIPT_CHARACTERS } from "@/lib/limits"
import { layoutReceipt, MAX_RECEIPT_LINES } from "@/lib/receipt"
import type { Job } from "@/lib/types"
import { DryRunField, JobResult } from "./job-result"
import { ReceiptPreview } from "./receipt-preview"

const DRAFT_KEY = "print.receipt.draft"
const count = new Intl.NumberFormat()

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

function readDraft() {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? ""
  } catch {
    return ""
  }
}

export function ReceiptForm({ disabled }: { disabled?: boolean }) {
  const queryClient = useQueryClient()
  const id = useId()
  const area = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(readDraft)
  const [dryRun, setDryRun] = useState(false)
  const [pending, setPending] = useState(false)
  const [touched, setTouched] = useState(false)
  const [result, setResult] = useState<{ job: Job; dryRun: boolean } | null>(
    null
  )
  // Layout follows typing without blocking it on long receipts.
  const deferred = useDeferredValue(text)
  const layout = useMemo(() => layoutReceipt(deferred), [deferred])
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

  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(DRAFT_KEY, text)
      else sessionStorage.removeItem(DRAFT_KEY)
    } catch {
      // Drafts are a convenience; private windows may refuse storage.
    }
  }, [text])

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
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={id}>Text</FieldLabel>
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
                          variant="ghost"
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
                placeholder={
                  "# Errands\n## Today\n- [ ] Pick up stamps\nCoffee beans | $14"
                }
                className="min-h-72 resize-y font-mono text-sm leading-relaxed"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              {error ? (
                <FieldError>{error}</FieldError>
              ) : (
                <FieldDescription className="tabular-nums">
                  {layout.lines.length} of {MAX_RECEIPT_LINES} lines,{" "}
                  {count.format(characters)} of{" "}
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
            {text ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setText("")
                  setTouched(false)
                  setResult(null)
                  area.current?.focus()
                }}
              >
                Clear
              </Button>
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
          <ReceiptPreview layout={layout} />
        </CardContent>
      </Card>
    </form>
  )
}
