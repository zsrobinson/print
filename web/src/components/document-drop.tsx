import { cn } from "@zsrobinson/shell"
import { UploadIcon } from "lucide-react"
import { useId, useState, type DragEvent } from "react"

/**
 * A labelled drop zone around a real, multi-file input: Tab reaches it, and
 * Enter or Space opens the file picker. It matches the shell's FileDrop.
 */
export function DocumentDrop({
  accept,
  onFiles,
  disabled,
  invalid,
  compact,
}: {
  accept: string
  onFiles: (files: File[]) => void
  disabled?: boolean
  invalid?: boolean
  /** A shorter zone once files are listed below it. */
  compact?: boolean
}) {
  const id = useId()
  const [over, setOver] = useState(false)

  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setOver(false)
    if (!disabled) onFiles([...event.dataTransfer.files])
  }

  return (
    <label
      htmlFor={id}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 text-center text-sm transition-colors hover:bg-muted/50 has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/30",
        compact ? "py-4 sm:flex-row" : "py-10",
        over && "border-ring bg-muted/50",
        invalid && "border-destructive",
        disabled && "pointer-events-none opacity-50"
      )}
    >
      <input
        id={id}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])])
          // Picking the same file again should add it again.
          event.target.value = ""
        }}
      />
      <UploadIcon className="size-5 text-muted-foreground" aria-hidden="true" />
      <span>
        <span className="font-medium">
          {compact ? "Add more files" : "Choose PDFs or images"}
        </span>
        <span className="text-muted-foreground"> or drop them here</span>
      </span>
    </label>
  )
}
