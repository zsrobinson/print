/**
 * A faithful port of the core's receipt layout (receipt.py), so the preview
 * shows the exact lines the printer will receive. Styles: T double-size title,
 * H inverted section bar, B bold, "" plain.
 */
export type ReceiptStyle = "" | "T" | "H" | "B"
export type ReceiptLine = { style: ReceiptStyle; text: string }
export type ReceiptLayout = {
  lines: ReceiptLine[]
  columns: number
  /** Set when the core would refuse this receipt. */
  error: string | null
}

export const RECEIPT_COLUMNS = 48
export const MAX_RECEIPT_LINES = 400

const REPLACEMENTS: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  "•": "-",
  " ": " ",
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "⇒": "->",
}
// Code points above Latin-1 that Windows-1252 can encode in 0x80–0x9F.
const CP1252_EXTRA = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split("").map((c) => c.codePointAt(0)!)
)
const CONTROL = /^\p{C}$/u

function encodable(char: string) {
  const code = char.codePointAt(0)!
  return code < 0x80 || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(code)
}

/** Python's str.expandtabs(4): tab stops reset at every line break. */
function expandTabs(text: string, size = 4) {
  let out = ""
  let column = 0
  for (const char of text) {
    if (char === "\t") {
      const pad = size - (column % size)
      out += " ".repeat(pad)
      column += pad
    } else {
      out += char
      column = char === "\n" ? 0 : column + 1
    }
  }
  return out
}

/** Keep line breaks, drop control characters, reduce to Windows-1252. */
export function normalize(text: string) {
  const source = expandTabs(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
  let result = ""
  for (const char of source) {
    if (char === "\n") {
      result += char
      continue
    }
    if (CONTROL.test(char)) continue
    const replaced = REPLACEMENTS[char]
    if (replaced !== undefined) result += replaced
    else if (encodable(char)) result += char
    // Python: NFKD, then ASCII with errors ignored, else "?".
    else result += char.normalize("NFKD").replace(/[^\p{ASCII}]/gu, "") || "?"
  }
  return result
}

/** Python's textwrap.wrap with break_long_words and without hyphen breaks. */
export function wrap(
  text: string,
  width: number,
  initialIndent = "",
  subsequentIndent = ""
) {
  // _munge_whitespace: every whitespace character becomes a single space.
  const munged = text.replace(/[\t\n\v\f\r]/g, " ")
  // textwrap splits on ASCII whitespace only.
  const chunks = munged.split(/( +)/).filter((chunk) => chunk !== "")
  chunks.reverse()
  const lines: string[] = []
  const blank = (chunk: string) => chunk.trim() === ""
  while (chunks.length) {
    const line: string[] = []
    let length = 0
    const indent = lines.length ? subsequentIndent : initialIndent
    const room = width - indent.length
    if (blank(chunks[chunks.length - 1]) && lines.length) chunks.pop()
    while (chunks.length) {
      const size = chunks[chunks.length - 1].length
      if (length + size <= room) {
        line.push(chunks.pop()!)
        length += size
      } else break
    }
    if (chunks.length && chunks[chunks.length - 1].length > room) {
      const space = room < 1 ? 1 : room - length
      const chunk = chunks[chunks.length - 1]
      line.push(chunk.slice(0, space))
      chunks[chunks.length - 1] = chunk.slice(space)
    }
    // drop_whitespace: a trailing space never ends a line.
    if (line.length && blank(line[line.length - 1])) line.pop()
    if (line.length) lines.push(indent + line.join(""))
  }
  return lines
}

const INLINE = /\*\*|__|`/g
const ITEM = /^(?:[-*] (\[[ xX]\] )|([-*] )|(\d+\. ))(.*)$/

export function layoutReceipt(
  text: string,
  columns = RECEIPT_COLUMNS
): ReceiptLayout {
  const lines: ReceiptLine[] = []
  if (text.length > 10_000)
    return {
      lines,
      columns,
      error: "Receipts can be up to 10,000 characters",
    }
  let error: string | null = null

  const append = (content: string, style: ReceiptStyle = "", prefix = "") => {
    let width = style === "T" ? Math.floor(columns / 2) : columns
    let value = ""
    if (!style && content.includes(" | ")) {
      const at = content.lastIndexOf(" | ")
      const right = content.slice(at + 3).trim()
      if (right && right.length <= Math.floor(columns / 3)) {
        content = content.slice(0, at)
        value = right
        width = columns - value.length - 2
      }
    }
    if (prefix.length >= width) {
      content = prefix + content
      prefix = ""
    }
    let wrapped = wrap(content, width, prefix, " ".repeat(prefix.length))
    if (!wrapped.length) wrapped = [prefix]
    let first = true
    for (let line of wrapped) {
      if (value && first) {
        line = line.padEnd(columns - value.length) + value
        first = false
      }
      if (style === "H") line = line.padEnd(columns)
      lines.push({ style, text: line })
      if (lines.length > MAX_RECEIPT_LINES && !error)
        error = `Receipts can be up to ${MAX_RECEIPT_LINES} lines`
    }
  }

  let blanks = 0
  for (let raw of normalize(text).split("\n")) {
    const bold = /^\*\*(.+)\*\*$/.test(raw)
    raw = raw.replace(INLINE, "")
    if (!raw.trim()) {
      blanks += 1
      if (blanks <= 2) append("")
      continue
    }
    blanks = 0
    if (raw.startsWith("# ")) append(raw.slice(2), "T")
    else if (raw.startsWith("## ")) append(raw.slice(3), "H", " ")
    else if (raw.trim() === "---")
      append("- ".repeat(columns).slice(0, columns).trimEnd())
    else if (bold) append(raw, "B")
    else {
      const item = ITEM.exec(raw)
      if (item) {
        const prefix = item[1] ?? (item[2] ? "- " : item[3])
        append(item[4], "", prefix.replace("[X]", "[x]"))
      } else append(raw)
    }
    if (lines.length > MAX_RECEIPT_LINES + 50) break
  }
  return { lines, columns, error }
}
