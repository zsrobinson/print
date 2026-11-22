import { cn } from "@zsrobinson/shell"
import { Button } from "@zsrobinson/shell/ui/button"
import { Skeleton } from "@zsrobinson/shell/ui/skeleton"
import { CheckIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  openPdf,
  pageAspect,
  renderPage,
  type PDFDocumentProxy,
} from "@/lib/pdf"

const INITIAL = 24
const WIDTH = 112

export type PdfState =
  | { status: "loading" }
  | { status: "ready"; pdf: PDFDocumentProxy; pages: number; aspect: number }
  | { status: "error" }

/** Open a PDF for thumbnails; `onPages` hears its page count once known. */
export function usePdf(file: Blob | null, onPages?: (pages: number) => void) {
  const [loaded, setLoaded] = useState<{ file: Blob; state: PdfState } | null>(
    null
  )
  const report = useRef(onPages)
  useEffect(() => {
    report.current = onPages
  })
  useEffect(() => {
    if (!file) return
    let cancelled = false
    let doc: PDFDocumentProxy | null = null
    openPdf(file)
      .then(async (pdf) => {
        doc = pdf
        const aspect = await pageAspect(pdf).catch(() => 8.5 / 11)
        if (cancelled) return
        setLoaded({
          file,
          state: { status: "ready", pdf, pages: pdf.numPages, aspect },
        })
        report.current?.(pdf.numPages)
      })
      .catch(() => {
        if (!cancelled) setLoaded({ file, state: { status: "error" } })
      })
    return () => {
      cancelled = true
      void doc?.destroy()
    }
  }, [file])
  return loaded && loaded.file === file
    ? loaded.state
    : ({ status: "loading" } as PdfState)
}

/**
 * Page thumbnails, drawn only as they scroll into view. With `onToggle` each
 * page is a toggle button; shift-click selects a run of pages.
 */
export function PdfPages({
  state,
  selected,
  onToggle,
  onSelectRun,
  label,
  className,
}: {
  state: PdfState
  /** Pages that will print; undefined when every page prints. */
  selected?: Set<number>
  onToggle?: (page: number) => void
  onSelectRun?: (from: number, to: number) => void
  label: string
  className?: string
}) {
  const [showAll, setShowAll] = useState(false)
  const last = useRef<number | null>(null)
  if (state.status === "error")
    return (
      <p className="text-sm text-muted-foreground">
        A preview is not available for this PDF. It still prints as is.
      </p>
    )
  if (state.status === "loading")
    return (
      <div className={cn("flex gap-2 overflow-hidden", className)}>
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-36 w-28 shrink-0 rounded-md" />
        ))}
      </div>
    )
  const count = showAll ? state.pages : Math.min(state.pages, INITIAL)
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <ul
        aria-label={label}
        className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(7rem,1fr))]"
      >
        {Array.from({ length: count }, (_, index) => {
          const page = index + 1
          const on = !selected || selected.has(page)
          return (
            <li key={page}>
              <Thumb
                pdf={state.pdf}
                page={page}
                aspect={state.aspect}
                on={on}
                selectable={Boolean(onToggle)}
                onClick={(event) => {
                  if (!onToggle) return
                  if (event.shiftKey && last.current && onSelectRun)
                    onSelectRun(last.current, page)
                  else onToggle(page)
                  last.current = page
                }}
              />
            </li>
          )
        })}
      </ul>
      {state.pages > count ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAll(true)}
          >
            Show all {state.pages} pages
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Thumb({
  pdf,
  page,
  aspect,
  on,
  selectable,
  onClick,
}: {
  pdf: PDFDocumentProxy
  page: number
  aspect: number
  on: boolean
  selectable: boolean
  onClick: (event: React.MouseEvent) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const node = canvas.current
    if (!node) return
    let done = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((entry) => entry.isIntersecting)) return
        done = true
        observer.disconnect()
        renderPage(pdf, page, node, WIDTH)
          .then(() => setDrawn(true))
          .catch(() => setDrawn(true))
      },
      { rootMargin: "200px" }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [pdf, page])

  const body = (
    <>
      <span
        className={cn(
          "relative block w-full overflow-hidden rounded-md border bg-white transition-[opacity,box-shadow]",
          selectable && on && "ring-2 ring-primary",
          selectable && !on && "opacity-40"
        )}
        style={{ aspectRatio: aspect }}
      >
        <canvas
          ref={canvas}
          aria-hidden="true"
          className={cn(
            "absolute inset-0 size-full transition-opacity",
            drawn ? "opacity-100" : "opacity-0"
          )}
        />
        {selectable && on ? (
          <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-3" aria-hidden="true" />
          </span>
        ) : null}
      </span>
      <span className="mt-1 block text-center text-xs text-muted-foreground tabular-nums">
        {page}
      </span>
    </>
  )
  if (!selectable) return <div>{body}</div>
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`Page ${page}`}
      onClick={onClick}
      className="block w-full cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {body}
    </button>
  )
}
