import { cn, PageMeta } from "@zsrobinson/shell"
import type { ComponentProps } from "react"

/** PageMeta with a middle dot between items, so facts never run together. */
export function Meta({ className, ...props }: ComponentProps<typeof PageMeta>) {
  return (
    <PageMeta
      className={cn(
        "[&>*+*]:before:mr-3 [&>*+*]:before:text-muted-foreground/60 [&>*+*]:before:content-['·']",
        className
      )}
      {...props}
    />
  )
}
