import { SIDES_LABELS } from "./jobs"
import { mediaLabel } from "./reasons"
import type { Printer } from "./types"

/** "Two-sided · Letter, Legal, A4 · Colour", from what the printer reports. */
export function capabilitySummary(printer: Printer) {
  const caps = printer.capabilities
  if (!caps) return null
  const parts: string[] = []
  parts.push(
    caps.sides.some((side) => side !== "one-sided") ? "Two-sided" : "One-sided"
  )
  const media = [...new Set(caps.media.map(mediaLabel))]
  if (media.length)
    parts.push(
      media.length > 3
        ? `${media.slice(0, 3).join(", ")} +${media.length - 3}`
        : media.join(", ")
    )
  if (caps.color !== null) parts.push(caps.color ? "Colour" : "Black only")
  return parts.join(" · ")
}

export const sidesList = (printer: Printer) =>
  (printer.capabilities?.sides ?? []).map((side) => SIDES_LABELS[side] ?? side)
