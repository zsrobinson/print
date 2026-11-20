/** Limits shared by the browser and the proxy. The core enforces its own as well. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
/** Multipart framing and the small option fields, on top of one file. */
export const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024
export const MAX_RECEIPT_CHARACTERS = 10_000
export const MAX_COPIES = 100
export const MAX_PAGE_RANGE = 200
export const PAGE_RANGE = /^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/
export const DUPLEX = [
  "one-sided",
  "two-sided-long-edge",
  "two-sided-short-edge",
] as const
export type Duplex = (typeof DUPLEX)[number]
export const PRINTERS = ["document", "receipt"] as const
export type PrinterId = (typeof PRINTERS)[number]
/** Opaque core job ids: no slashes, dots-only segments or whitespace. */
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/

export type DocumentType = "application/pdf" | "image/png" | "image/jpeg"

/** Identify a document by its leading bytes, never by its name or declared type. */
export function sniff(bytes: Uint8Array): DocumentType | null {
  const starts = (signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte)
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png"
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg"
  return null
}

/** Returns an error message, or null when the range is acceptable. */
export function pageRangeError(value: string) {
  if (value.length > MAX_PAGE_RANGE) return "Page range is too long"
  if (!PAGE_RANGE.test(value)) return "Use page ranges such as 1-3,5"
  for (const part of value.split(",")) {
    const [start, end] = part.split("-").map(Number)
    if (end !== undefined && start > end) return "Page ranges must run forwards"
  }
  return null
}
