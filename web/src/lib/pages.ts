/** Page numbers in a range such as "1-3,5", or null when it does not parse. */
export function parsePages(range: string, total?: number) {
  const value = range.trim()
  if (!value) return null
  const pages = new Set<number>()
  for (const part of value.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part)
    if (!match) return null
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (start < 1 || end < start) return null
    if (total !== undefined && end > total) return null
    for (let page = start; page <= end && pages.size <= 10_000; page++)
      pages.add(page)
  }
  return pages
}

/** The shortest range text for a set of pages: 1-3,5,8-9. */
export function formatPages(pages: Iterable<number>) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++
    parts.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`)
  }
  return parts.join(",")
}
