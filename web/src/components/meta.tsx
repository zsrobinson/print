import { cn, PageMeta } from "@zsrobinson/shell"
import type { ComponentProps } from "react"

/** PageMeta with a middle dot between items, so facts never run together. */
export function Meta({ className, ...props }: ComponentProps<typeof PageMeta>) {
  return (
    <PageMeta
      className={cn(
        // Phones stack the items, so no separator is left starting a line.
        "max-sm:flex-col max-sm:items-start max-sm:gap-y-0.5 sm:[&>*+*]:before:mr-3 sm:[&>*+*]:before:text-muted-foreground/60 sm:[&>*+*]:before:content-['·']",
        className
      )}
      {...props}
    />
  )
}
