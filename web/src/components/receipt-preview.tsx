import { cn } from "@zsrobinson/shell"
import type { ReceiptLayout, ReceiptLine } from "@/lib/receipt"

/**
 * The receipt as the printer lays it out: one monospace cell per character,
 * cells twice as tall as they are wide (12×24 dots), titles at double size.
 * The type scales down with its container so all columns stay visible.
 */
export function ReceiptPreview({ layout }: { layout: ReceiptLayout }) {
  const { lines, columns } = layout
  return (
    <div className="@container w-full">
      {/* The shadow lives on a wrapper so it follows the masked edge. */}
      <div className="mx-auto w-fit drop-shadow-[0_2px_6px_rgb(16_15_15/0.18)] dark:drop-shadow-none">
        <figure
          aria-label={`Receipt preview, ${lines.length} lines`}
          className={cn(
            "bg-(--flexoki-paper) px-[1.5em] pt-[1.8em] pb-[2.4em] font-mono text-(--flexoki-black) dark:bg-(--flexoki-100)",
            // A torn edge where the cutter will be.
            "[mask:radial-gradient(0.36em_at_50%_100%,#0000_96%,#000)_50%_100%/0.72em_100%_repeat-x]",
            "text-[length:min(13px,calc((100cqw-3em)/28.8))]"
          )}
        >
          <div style={{ width: `${columns}ch` }} className="overflow-hidden">
            {lines.length ? (
              lines.map((line, index) => <Line key={index} line={line} />)
            ) : (
              <p className="h-[1.2em] leading-[1.2em] text-(--flexoki-500)">
                Start typing to lay out the receipt.
              </p>
            )}
          </div>
        </figure>
      </div>
    </div>
  )
}

function Line({ line }: { line: ReceiptLine }) {
  if (line.style === "T")
    return (
      <div className="h-[1.2em] text-[2em] leading-[1.2em] font-bold whitespace-pre">
        {line.text}
      </div>
    )
  return (
    <div
      className={cn(
        "h-[1.2em] leading-[1.2em] whitespace-pre",
        line.style && "font-bold",
        line.style === "H" &&
          "w-fit bg-(--flexoki-black) text-(--flexoki-paper) dark:text-(--flexoki-100)"
      )}
    >
      {line.text || " "}
    </div>
  )
}
